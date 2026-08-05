// Browser-restart policy (sessionRestore.ts) against the real storage layers: fake-indexeddb
// backs the kv SSOT (gauge state, drift clock, last-alive marker) and an in-memory stub backs
// chrome.storage.local (goal, settings, notice flags). Verifies the three restart outcomes —
// 경우 ① continue (short gap), 경우 ② suspend (long gap / opt-out), and 이어가기 (resume) —
// and that the reducer clock is rebased so downtime is never integrated.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

const store = new Map<string, unknown>()
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (obj: Record<string, unknown>) =>
        void Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
      remove: async (key: string) => void store.delete(key),
    },
  },
  // Badge fallback path (no OffscreenCanvas in Node) + the auto-popup probe. No openPopup on
  // purpose: scheduleAutoPopup must tolerate its absence.
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
  runtime: { getURL: (p: string) => p },
  tabs: { query: async () => [] },
}

// Quiet the [kbz] diagnostics.
console.log = () => {}

const { addRecord, clearStore, getAllRecords, kvGet, kvSet, OUTBOX_STORE } = await import("./db.ts")
const { setGoal, getGoal, getSuspendedSession } = await import("./session.ts")
const { setSettings } = await import("./settings.ts")
const {
  RESTORE_GAP_MS,
  restoreDecision,
  noteAlive,
  handleBrowserStartup,
  resumeSuspendedSession,
  getRestoreNotice,
} = await import("./sessionRestore.ts")
const { currentState } = await import("./gaugeRuntime.ts")

const STATE_KEY = "gauge-state"
const DRIFT_SINCE_KEY = "drift-since"

/** A minimal but shape-valid gauge checkpoint mid-DRIFT, last touched at `updatedAt`. */
function driftingState(updatedAt: number): Record<string, unknown> {
  return {
    s: 50,
    m: 0.6,
    accelTier: 0,
    updatedAt,
    activePageKey: "youtube.com#watch",
    activeVerdict: "DRIFT",
    activeMargin: null,
    degraded: true,
    pendingTier2: null,
    tier2ReqSeq: 0,
    nagN: 0,
    renagDebt: 0,
    lastNagTs: null,
    lastJudgment: null,
    snoozedUntil: null,
    celebrateArmed: false,
  }
}

async function resetWorld(): Promise<void> {
  store.clear()
  await kvSet(STATE_KEY, null) // loadState treats a non-state as init
  await kvSet(DRIFT_SINCE_KEY, null)
  await kvSet("last-alive", null)
  await kvSet("session-visits", null)
}

test("restoreDecision: the 5-minute window, gated on the opt-in", () => {
  assert.equal(restoreDecision(RESTORE_GAP_MS, true), "continue")
  assert.equal(restoreDecision(RESTORE_GAP_MS + 1, true), "suspend")
  assert.equal(restoreDecision(0, false), "suspend", "자동 유지 OFF suspends even instant restarts")
})

test("경우 ①: a short-gap relaunch continues the session — clock rebased, anchors shifted, banner queued", async () => {
  await resetWorld()
  const declared = await setGoal("논문 정리", 60)
  assert.ok(declared)

  const now = Date.now()
  const gap = 2 * 60_000
  const shutdownAt = now - gap
  const driftStart = shutdownAt - 30 * 60_000
  // The session really started before the shutdown — backdate the just-declared goal so the
  // startedAt fallback in the gap estimate doesn't mask the seeded last-alive marker.
  const sessionStart = now - 40 * 60_000
  store.set("kibitzer:goal:v1", { ...declared, startedAt: sessionStart })
  await noteAlive(shutdownAt)
  await kvSet(STATE_KEY, driftingState(shutdownAt - 20_000))
  await kvSet(DRIFT_SINCE_KEY, driftStart)

  await handleBrowserStartup()

  const goal = await getGoal()
  assert.ok(goal, "the session survives")
  assert.equal(goal.epoch, declared.epoch, "same session, not a redeclare")
  const shift = goal.startedAt - sessionStart
  assert.ok(shift >= gap && shift < gap + 5_000, `startedAt shifted by ≈gap (got ${shift})`)

  const state = await currentState()
  assert.equal(state.s, 50, "the gap must not drain S under the pre-shutdown DRIFT verdict")
  assert.ok(state.updatedAt >= now, "reducer clock rebased to relaunch time")

  const since = await kvGet<number>(DRIFT_SINCE_KEY)
  assert.ok(since != null && since - driftStart >= gap, "drift clock pushed past the downtime")

  assert.ok(await getRestoreNotice(goal), "the ① banner event is queued for the popup")
  assert.equal(await getSuspendedSession(), null)
})

test("경우 ②: a long-gap relaunch parks the session as resumable; 이어가기 restores the SAME epoch", async () => {
  await resetWorld()
  const declared = await setGoal("보고서 쓰기", null)
  assert.ok(declared)

  const now = Date.now()
  const shutdownAt = now - 60 * 60_000 // gone for an hour
  const sessionStart = now - 3 * 60 * 60_000
  store.set("kibitzer:goal:v1", { ...declared, startedAt: sessionStart })
  await noteAlive(shutdownAt)
  await kvSet(STATE_KEY, driftingState(shutdownAt - 20_000))

  await handleBrowserStartup()

  assert.equal(await getGoal(), null, "no live session after a long gap")
  const suspended = await getSuspendedSession()
  assert.ok(suspended, "…but it is parked, not lost")
  assert.equal(suspended.goal.epoch, declared.epoch)
  assert.equal(suspended.downFrom, shutdownAt, "the session's stop time is the shutdown, not the relaunch")
  assert.equal(await getRestoreNotice(await getGoal()), null)

  const resumed = await resumeSuspendedSession()
  assert.ok(resumed)
  assert.equal(resumed.epoch, declared.epoch, "완전 연속 — the gauge/visits still belong to it")
  assert.ok(resumed.startedAt >= sessionStart + 60 * 60_000 - 5_000, "downtime excluded from elapsed")
  assert.equal(await getSuspendedSession(), null)
  const state = await currentState()
  assert.equal(state.s, 50, "the parked hour never integrated")
  assert.ok(state.updatedAt >= now, "reducer clock rebased at resume")
})

test("자동 유지 OFF: even a seconds-long restart suspends (항상 suspend)", async () => {
  await resetWorld()
  await setSettings({ sessionAutoContinue: false })
  const declared = await setGoal("코딩", null)
  assert.ok(declared)
  await noteAlive(Date.now() - 10_000)

  await handleBrowserStartup()

  assert.equal(await getGoal(), null)
  assert.equal((await getSuspendedSession())?.goal.epoch, declared.epoch)
  await setSettings({ sessionAutoContinue: true })
})

test("no goal at relaunch → the policy is a no-op", async () => {
  await resetWorld()
  await handleBrowserStartup()
  assert.equal(await getGoal(), null)
  assert.equal(await getSuspendedSession(), null)
})

// The startupSettled barrier contract lives in sessionRestore.barrier.test.ts — it needs a
// FRESH module instance (this file's earlier handleBrowserStartup calls and the fallback
// timer would have long settled the barrier, making any assertion here vacuously green).

test("칭찬은 재시작을 넘지 않는다: any relaunch purges queued celebrates, keeps queued nags", async () => {
  await resetWorld()
  const declared = await setGoal("리포트 마무리", null)
  assert.ok(declared)
  const now = Date.now()
  store.set("kibitzer:goal:v1", { ...declared, startedAt: now - 40 * 60_000 })
  await noteAlive(now - 60_000) // 1-minute gap → continue path (the harder case: session survives)
  await clearStore(OUTBOX_STORE)
  await addRecord(OUTBOX_STORE, { effect: { type: "celebrate" }, goal: declared, ts: now - 30_000, writerMessage: null, source: null })
  await addRecord(OUTBOX_STORE, { effect: { type: "nag", pageKey: "x.test#1" }, goal: declared, ts: now - 30_000, writerMessage: null, source: null })

  await handleBrowserStartup()

  // The rebase's own drain already ran, so look at both surfaces: the celebrate must exist
  // NOWHERE (purged before any drain could touch it), while the nag flows into the delivery
  // gate — no matching tab in this harness, so it lands parked in the hold slot.
  const left = await getAllRecords<{ effect: { type: string } }>(OUTBOX_STORE)
  assert.ok(!left.some((r) => r.effect.type === "celebrate"), "the celebrate died with the shutdown")
  const hold = await kvGet<{ pageKey: string }>("nag-hold")
  assert.equal(hold?.pageKey, "x.test#1", "the nag survived into the delivery gate instead")
  await clearStore(OUTBOX_STORE)
  await kvSet("nag-hold", null)
})

test("②-이어가기 clears celebrateArmed — 아직 아무것도 안 했는데 다짜고짜 칭찬 방지", async () => {
  await resetWorld()
  const declared = await setGoal("보고서 쓰기", null)
  assert.ok(declared)
  const now = Date.now()
  const shutdownAt = now - 60 * 60_000
  store.set("kibitzer:goal:v1", { ...declared, startedAt: now - 3 * 60 * 60_000 })
  await noteAlive(shutdownAt)
  // Parked mid-arc: dropped to ≤20 earlier (arm), partially recovered to 45 before the quit.
  await kvSet(STATE_KEY, { ...driftingState(shutdownAt - 20_000), s: 45, activeVerdict: "OK", celebrateArmed: true })

  await handleBrowserStartup() // gap 1h → suspend
  assert.equal(await getGoal(), null)

  const resumed = await resumeSuspendedSession()
  assert.ok(resumed)
  const state = await kvGet<{ celebrateArmed: boolean; s: number }>(STATE_KEY)
  assert.equal(state?.celebrateArmed, false, "the half-old celebration arc dies at resume")
  assert.equal(state?.s, 45, "everything else about the gauge continues untouched")
})

test("a goal declared moments before the quit has no last-alive marker — startedAt bounds the gap", async () => {
  await resetWorld()
  const declared = await setGoal("방금 선언한 목표", null)
  assert.ok(declared)
  // No noteAlive at all (the 1-min heartbeat never ticked before the quit). The gap must be
  // measured from startedAt (≈ now), NOT from epoch 0 — which would wrongly suspend.
  await handleBrowserStartup()
  assert.ok(await getGoal(), "a just-declared session continues")
  assert.equal(await getSuspendedSession(), null)
})

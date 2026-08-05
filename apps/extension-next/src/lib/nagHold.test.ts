// D19 delivery gate — the held-nag lifecycle and the celebrate gates, against the real
// gaugeRuntime pipeline (fake-indexeddb SSOT + chrome stub). Covers what the reducer tests
// can't: 잔소리는 유발한 페이지 위에서만 뜨고, 떠났으면 보류(단일 슬롯·3분 TTL·3초 유예),
// 회복하면 그 즉시 무효화되며, 축하는 현재 판정이 OK일 때만 나간다.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

type MockTab = { id: number; url: string; title: string; active: boolean; windowId: number }
let activeTab: MockTab | null = null
let winFocused = true
const toasts: Array<Record<string, unknown>> = []
const notifications: Array<{ id: string; opts: Record<string, unknown> }> = []

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
  tabs: { query: async () => (activeTab ? [activeTab] : []) },
  windows: { getLastFocused: async () => ({ focused: winFocused, id: 1 }) },
  idle: { queryState: async () => "active" },
  scripting: {
    executeScript: async ({ args }: { args?: unknown[] }) => {
      const payload = args?.[0]
      if (payload && typeof payload === "object" && "message" in payload) {
        toasts.push(payload as Record<string, unknown>)
      }
      return [{ result: undefined }]
    },
  },
  notifications: {
    create: async (id: string, opts: Record<string, unknown>) => void notifications.push({ id, opts }),
    clear: async () => {},
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {},
    Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
  },
  runtime: { getURL: (p: string) => p, sendMessage: async () => {} },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
}
console.log = () => {}

const { addRecord, clearStore, getAllRecords, kvGet, kvSet, kvDelete, OUTBOX_STORE } = await import("./db.ts")
const {
  flushOutbox,
  pokeNagHold,
  dispatch,
  purgeQueuedCelebrates,
  disarmCelebrate,
  currentState,
} = await import("./gaugeRuntime.ts")
const { getGoal } = await import("./session.ts")
const { describeObservableUrl } = await import("./url.ts")

const HOLD_KEY = "nag-hold"
const STATE_KEY = "gauge-state"
const PAGE_A = { id: 1, url: "https://work.test/docs/spec", title: "작업 문서", active: true, windowId: 1 }
const PAGE_B = { id: 2, url: "https://elsewhere.test/feed", title: "다른 페이지", active: true, windowId: 1 }
// The trigger page's identity EXACTLY as the delivery gate computes it — the same descriptor
// the pipeline uses, so hold/pageKey assertions test the real match, not a lookalike string.
const PAGE_A_KEY = describeObservableUrl(PAGE_A.url)?.pageKey as string

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function seedGoal(): Promise<NonNullable<Awaited<ReturnType<typeof getGoal>>>> {
  store.set("kibitzer:goal:v1", {
    text: "명세 문서 정리",
    availableMinutes: null,
    startedAt: Date.now() - 30 * 60_000,
    revision: 0,
    epoch: 7,
  })
  const goal = await getGoal()
  assert.ok(goal)
  return goal
}

function gaugeState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    s: 10,
    m: 0.8,
    accelTier: 0,
    updatedAt: Date.now(),
    activePageKey: null,
    activeVerdict: null,
    activeMargin: null,
    degraded: true,
    pendingTier2: null,
    tier2ReqSeq: 0,
    nagN: 1,
    renagDebt: 0,
    lastNagTs: null,
    lastJudgment: null,
    snoozedUntil: null,
    celebrateArmed: false,
    ...overrides,
  }
}

async function seedNagRecord(pageKey: string, ts: number, message: string): Promise<void> {
  const goal = await getGoal()
  await addRecord(OUTBOX_STORE, {
    effect: { type: "nag", pageKey },
    goal,
    ts,
    writerMessage: message,
    source: null,
  })
}

async function resetWorld(): Promise<void> {
  toasts.length = 0
  notifications.length = 0
  activeTab = null
  winFocused = true
  store.clear()
  await clearStore(OUTBOX_STORE)
  await kvDelete(HOLD_KEY)
  await kvSet(STATE_KEY, null)
  await kvDelete("active-page")
  await kvDelete("first-nag-count")
}

test("fixture sanity: the two mock pages resolve to distinct observable pageKeys", () => {
  assert.ok(PAGE_A_KEY, "PAGE_A must be observable")
  assert.notEqual(describeObservableUrl(PAGE_B.url)?.pageKey, PAGE_A_KEY)
})

test("a nag reaching delivery on the WRONG page is parked in the hold slot, not shown", async () => {
  await resetWorld()
  const goal = await seedGoal()
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "DRIFT" }))
  activeTab = PAGE_B // the user wandered off before delivery
  await seedNagRecord(PAGE_A_KEY, Date.now(), "명세로 돌아가요")

  await flushOutbox()

  assert.equal(toasts.length + notifications.length, 0, "no nudge on an unrelated page")
  const hold = await kvGet<{ pageKey: string; writerMessage: string; epoch: number }>(HOLD_KEY)
  assert.equal(hold?.pageKey, PAGE_A_KEY)
  assert.equal(hold?.writerMessage, "명세로 돌아가요", "the Writer message rides the hold")
  assert.equal(hold?.epoch, goal.epoch)
})

test("returning to the page delivers the held nag AFTER the grace — and consumes the hold", async () => {
  // Continues the world of the previous test: hold for PAGE_A exists.
  activeTab = PAGE_A
  const goal = await getGoal()
  assert.ok(goal)
  await pokeNagHold(goal)

  // Check well inside the 3 s grace (2.5 s cushion for a loaded CI runner).
  await settle(500)
  assert.equal(toasts.length, 0, "the grace window defers delivery — no instant ambush")

  let delivered = false
  for (let i = 0; i < 60 && !delivered; i += 1) {
    await settle(100)
    delivered = toasts.length > 0
  }
  assert.ok(delivered, "the held nag delivers once the grace elapses")
  assert.equal((toasts[0] as { message?: string }).message, "명세로 돌아가요")
  assert.equal(await kvGet(HOLD_KEY), undefined, "delivery consumes the hold")
})

test("a hold past its 3-minute TTL is discarded on poke, even on the right page", async () => {
  await resetWorld()
  const goal = await seedGoal()
  await kvSet(HOLD_KEY, {
    pageKey: PAGE_A_KEY,
    createdAt: Date.now() - 3 * 60_000 - 1000,
    epoch: goal.epoch,
    writerMessage: "이미 식은 잔소리",
    source: null,
  })
  activeTab = PAGE_A

  await pokeNagHold(goal)

  assert.equal(await kvGet(HOLD_KEY), undefined, "expired hold cleared without arming a grace")
  await settle(200)
  assert.equal(toasts.length, 0, "…and nothing ever surfaces")
})

test("a hold from another session (epoch mismatch) is discarded on poke", async () => {
  await resetWorld()
  const goal = await seedGoal()
  await kvSet(HOLD_KEY, {
    pageKey: PAGE_A_KEY,
    createdAt: Date.now(),
    epoch: goal.epoch + 1,
    writerMessage: "남의 세션 잔소리",
    source: null,
  })
  activeTab = PAGE_A

  await pokeNagHold(goal)

  assert.equal(await kvGet(HOLD_KEY), undefined)
  await settle(200)
  assert.equal(toasts.length, 0)
})

test("newest wins: a newer nag reaching delivery evicts the parked older one", async () => {
  await resetWorld()
  const goal = await seedGoal()
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "DRIFT" }))
  await kvSet(HOLD_KEY, {
    pageKey: "old.test#deadbeef",
    createdAt: Date.now() - 60_000,
    epoch: goal.epoch,
    writerMessage: "옛 보류 잔소리",
    source: null,
  })
  activeTab = PAGE_A
  await seedNagRecord(PAGE_A_KEY, Date.now(), "새 잔소리")

  await flushOutbox() // matches the active page + present → delivers directly

  assert.equal(toasts.length, 1, "the new nag delivered")
  assert.equal((toasts[0] as { message?: string }).message, "새 잔소리")
  assert.equal(await kvGet(HOLD_KEY), undefined, "the older parked nag is gone regardless")
})

test("gauge recovery invalidates the hold the moment it happens (합의안 5)", async () => {
  await resetWorld()
  const goal = await seedGoal()
  // Drifting at S=10 with a parked nag; the user then fixes the drift ("관련 있어요" → nav OK).
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "DRIFT" }))
  await kvSet(HOLD_KEY, {
    pageKey: PAGE_A_KEY,
    createdAt: Date.now(),
    epoch: goal.epoch,
    writerMessage: "이제는 부당한 잔소리",
    source: null,
  })
  activeTab = PAGE_A

  await dispatch({ type: "nav", pageKey: PAGE_A_KEY, verdict: "OK", ts: Date.now() }, goal)

  assert.equal(await kvGet(HOLD_KEY), undefined, "verdict flip on the held page empties the slot")
  await settle(200)
  assert.equal(toasts.length, 0)
})

test("celebrate is gated on the CURRENT verdict being OK — a DRIFT/NEUTRAL page discards it", async () => {
  await resetWorld()
  const goal = await seedGoal()
  activeTab = PAGE_A
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "DRIFT", s: 85 }))
  await addRecord(OUTBOX_STORE, { effect: { type: "celebrate" }, goal, ts: Date.now(), writerMessage: null, source: null })
  await flushOutbox()
  assert.equal(toasts.length, 0, "no praise while the live verdict is not OK")

  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "OK", s: 85 }))
  await addRecord(OUTBOX_STORE, { effect: { type: "celebrate" }, goal, ts: Date.now(), writerMessage: null, source: null })
  await flushOutbox()
  assert.equal(toasts.length, 1, "the same effect delivers once the verdict is OK")
  assert.equal((toasts[0] as { kind?: string }).kind, "celebration")
})

test("quiet hours silence celebrates too — chime included, no hold", async () => {
  await resetWorld()
  const goal = await seedGoal()
  activeTab = PAGE_A
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "OK", s: 85 }))
  // A quiet window straddling "now" regardless of wall-clock (start 1h ago, end 1h ahead).
  const hhmm = (t: number): string => {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }
  store.set("kibitzer:settings:v1", {
    quietHours: { enabled: true, start: hhmm(Date.now() - 60 * 60_000), end: hhmm(Date.now() + 60 * 60_000) },
  })
  await addRecord(OUTBOX_STORE, { effect: { type: "celebrate" }, goal, ts: Date.now(), writerMessage: null, source: null })
  await flushOutbox()
  assert.equal(toasts.length + notifications.length, 0)
})

test("purgeQueuedCelebrates drops only celebrates; nags stay queued", async () => {
  await resetWorld()
  const goal = await seedGoal()
  await addRecord(OUTBOX_STORE, { effect: { type: "celebrate" }, goal, ts: Date.now(), writerMessage: null, source: null })
  await seedNagRecord(PAGE_A_KEY, Date.now(), "남아야 하는 잔소리")

  await purgeQueuedCelebrates()

  const left = await getAllRecords<{ effect: { type: string } }>(OUTBOX_STORE)
  assert.deepEqual(left.map((r) => r.effect.type), ["nag"])
})

test("disarmCelebrate clears the arm; a fresh state is untouched", async () => {
  await resetWorld()
  await seedGoal()
  await kvSet(STATE_KEY, gaugeState({ celebrateArmed: true, s: 45 }))
  await disarmCelebrate()
  const state = await currentState()
  assert.equal(state.celebrateArmed, false)
  assert.equal(state.s, 45, "only the arm is touched")
})

test("a stale queued nag (past the 3-minute TTL) never surfaces, even on the right page", async () => {
  await resetWorld()
  await seedGoal()
  await kvSet(STATE_KEY, gaugeState({ activePageKey: PAGE_A_KEY, activeVerdict: "DRIFT" }))
  activeTab = PAGE_A // right page, present — only the age disqualifies it
  await seedNagRecord(PAGE_A_KEY, Date.now() - 3 * 60_000 - 1000, "식은 잔소리")

  await flushOutbox()

  assert.equal(toasts.length + notifications.length, 0)
  assert.equal(await kvGet(HOLD_KEY), undefined, "TTL death is a drop, not a hold")
})

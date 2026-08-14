// The durable goal epoch must be strictly monotonic across the whole extension lifetime —
// including a clear+redeclare, where `revision` alone repeats 0 and can't distinguish
// sessions. session.ts only touches chrome.storage.local, stubbed in-memory here.

import assert from "node:assert/strict"
import test from "node:test"

const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
      remove: async (key: string) => void delete store[key],
    },
  },
}

const {
  getGoal,
  setGoal,
  getSuspendedSession,
  suspendGoal,
  resumeSuspendedGoal,
  takeSuspendedSession,
  shiftGoalStart,
  GOAL_MAX_CHARS,
} = await import("./session.ts")

test("epoch is monotonic and never reused across a clear+redeclare", async () => {
  for (const k of Object.keys(store)) delete store[k]

  const a1 = await setGoal("독서", null)
  assert.equal(a1?.epoch, 1)
  assert.equal(a1?.revision, 0)

  // No change → neither epoch nor revision moves.
  const a1again = await setGoal("독서", null)
  assert.equal(a1again?.epoch, 1)
  assert.equal(a1again?.revision, 0)

  // A real change bumps both.
  const b = await setGoal("코딩", null)
  assert.equal(b?.epoch, 2)
  assert.equal(b?.revision, 1)

  // Clear, then redeclare the ORIGINAL goal: revision restarts at 0, but epoch keeps climbing.
  assert.equal(await setGoal("", null), null)
  const a2 = await setGoal("독서", null)
  assert.equal(a2?.revision, 0, "revision repeats after a clear")
  assert.equal(a2?.epoch, 3, "epoch does not")
  assert.notEqual(a2?.epoch, a1?.epoch, "the two 독서 sessions are distinguishable")

  assert.equal((await getGoal())?.epoch, 3)
})

test("goal text is clamped at set AND at read — oversized text never reaches a payload", async () => {
  for (const k of Object.keys(store)) delete store[k]

  // Pasted/scripted goals have no upstream bound; the cap must hold at ingress.
  const set = await setGoal("가".repeat(GOAL_MAX_CHARS + 5000), null)
  assert.equal(Array.from(set?.text ?? "").length, GOAL_MAX_CHARS)

  // A goal stored before the cap existed (or written by anything else) is clamped on read —
  // by code point, so a surrogate pair at the boundary is never split into a lone half.
  store["kibitzer:goal:v1"] = { text: "😀".repeat(GOAL_MAX_CHARS * 2), availableMinutes: null }
  const read = await getGoal()
  assert.equal(Array.from(read?.text ?? "").length, GOAL_MAX_CHARS)
  assert.ok(read?.text.endsWith("😀"), "no lone surrogate at the clamp boundary")

  // Same oversized text set twice is "unchanged" — the comparison sees the clamped value,
  // so epoch/revision must not churn.
  for (const k of Object.keys(store)) delete store[k]
  const long = "지".repeat(GOAL_MAX_CHARS + 1)
  const first = await setGoal(long, null)
  const second = await setGoal(long, null)
  assert.equal(second?.epoch, first?.epoch)
  assert.equal(second?.revision, first?.revision)
})

test("concurrent setGoal calls linearize — no two goals share an epoch", async () => {
  for (const k of Object.keys(store)) delete store[k]
  // A double-clicked popup button fires two setGoal calls at once. Their read-modify-write of
  // the epoch counter must be serialized, not both read the same pre-increment value.
  const [a, b] = await Promise.all([setGoal("A", null), setGoal("B", null)])
  const epochs = [a?.epoch, b?.epoch].sort()
  assert.deepEqual(epochs, [1, 2], "distinct, ordered epochs")
})

test("suspend parks the goal (getGoal → null); resume restores the SAME epoch with startedAt shifted past the downtime", async () => {
  for (const k of Object.keys(store)) delete store[k]

  const declared = await setGoal("논문 정리", 60)
  assert.ok(declared)
  const downFrom = declared.startedAt + 10 * 60_000 // browser last alive 10min into the session

  const suspended = await suspendGoal(downFrom, downFrom + 60 * 60_000)
  assert.equal(suspended?.goal.epoch, declared.epoch)
  assert.equal(await getGoal(), null, "a suspended session must stop every goal-guarded path")
  assert.equal((await getSuspendedSession())?.downFrom, downFrom)

  // Resume 2 hours after the shutdown: same epoch/revision (the gauge/visits still belong to
  // it), startedAt pushed forward by exactly the downtime so elapsed time excludes it.
  const resumeAt = downFrom + 2 * 60 * 60_000
  const resumed = await resumeSuspendedGoal(resumeAt)
  assert.equal(resumed?.epoch, declared.epoch)
  assert.equal(resumed?.revision, declared.revision)
  assert.equal(resumed?.startedAt, declared.startedAt + (resumeAt - downFrom))
  assert.equal(await getSuspendedSession(), null, "resume consumes the parked record")
  assert.equal((await getGoal())?.epoch, declared.epoch)
})

test("resume never clobbers an already-active goal; take removes without restoring", async () => {
  for (const k of Object.keys(store)) delete store[k]

  const first = await setGoal("독서", null)
  assert.ok(first)
  await suspendGoal(first.startedAt + 1000, first.startedAt + 2000)

  // A NEW goal was declared while the old session sat parked (the quiet-close path).
  const second = await setGoal("코딩", null)
  assert.ok(second)
  assert.equal(await resumeSuspendedGoal(Date.now()), null, "active goal wins")
  assert.equal((await getGoal())?.text, "코딩", "the live goal is untouched")

  const taken = await takeSuspendedSession()
  assert.equal(taken?.goal.text, "독서")
  assert.equal(await takeSuspendedSession(), null, "take consumes the record")
})

test("shiftGoalStart moves startedAt forward without touching epoch/revision, clamped to now", async () => {
  for (const k of Object.keys(store)) delete store[k]

  const goal = await setGoal("공부", 30)
  assert.ok(goal)
  // Precondition of the real callers: startedAt sits in the past by at least the shift
  // (gap = now − lastAlive and startedAt ≤ lastAlive). Backdate to simulate that.
  store["kibitzer:goal:v1"] = { ...goal, startedAt: goal.startedAt - 600_000 }
  const shifted = await shiftGoalStart(90_000)
  assert.equal(shifted?.startedAt, goal.startedAt - 600_000 + 90_000)
  assert.equal(shifted?.epoch, goal.epoch)
  assert.equal(shifted?.revision, goal.revision)

  // A pathological shift can't push the anchor into the future.
  const clamped = await shiftGoalStart(365 * 24 * 60 * 60_000)
  assert.ok(clamped && clamped.startedAt <= Date.now())

  assert.equal(await shiftGoalStart(0).then((g) => g?.startedAt), clamped?.startedAt, "0 shift is a no-op")
})

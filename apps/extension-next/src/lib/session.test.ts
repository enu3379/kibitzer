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

const { getGoal, setGoal, GOAL_MAX_CHARS } = await import("./session.ts")

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

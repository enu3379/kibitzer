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

const { getGoal, setGoal } = await import("./session.ts")

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

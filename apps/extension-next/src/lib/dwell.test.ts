import assert from "node:assert/strict"
import test from "node:test"

import { dwellDecision, type PendingDwell } from "./dwell.ts"

const pending = (over: Partial<PendingDwell> = {}): PendingDwell => ({
  url: "https://a.test/x",
  title: "X",
  obsKey: "a.test/x\nX",
  dueAt: 5000,
  ...over,
})

test("skips when nothing is pending", () => {
  assert.deepEqual(dwellDecision(null, "a.test/x\nX", 6000), { action: "skip" })
  assert.deepEqual(dwellDecision(undefined, null, 6000), { action: "skip" })
})

test("skips when a newer candidate superseded the armed one", () => {
  assert.deepEqual(dwellDecision(pending(), "b.test/y\nY", 6000), { action: "skip" })
})

test("judges once the dwell has elapsed", () => {
  const p = pending({ dueAt: 5000 })
  assert.deepEqual(dwellDecision(p, p.obsKey, 5000), { action: "judge", pending: p })
  assert.deepEqual(dwellDecision(p, p.obsKey, 5001), { action: "judge", pending: p })
})

test("re-arms for the remaining time when the dwell hasn't elapsed", () => {
  assert.deepEqual(dwellDecision(pending({ dueAt: 5000 }), null, 3000), {
    action: "rearm",
    delayMs: 2000,
  })
})

test("reconcile (null expected) accepts whatever is checkpointed", () => {
  const p = pending({ obsKey: "whatever\nZ", dueAt: 1000 })
  assert.deepEqual(dwellDecision(p, null, 2000), { action: "judge", pending: p })
})

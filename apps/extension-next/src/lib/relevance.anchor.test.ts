// admitAnchor must be idempotent against a consecutive duplicate: the durable dwell is
// at-least-once, so a teardown-then-reconcile can re-judge the same page and re-admit the
// identical embedding. Without dedup that page is double-weighted in the anchor mean and
// burns two of ANCHOR_WINDOW slots. Real IndexedDB via fake-indexeddb.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import { admitAnchor, clearRelevance, loadRefs } from "./relevance.ts"

test("admitAnchor ignores a consecutive duplicate vector", async () => {
  await clearRelevance()
  await admitAnchor([1, 0, 0])
  await admitAnchor([1, 0, 0]) // re-judge of the same page (teardown → reconcile) — must be ignored
  await admitAnchor([0, 1, 0])

  const anchor = (await loadRefs()).anchor
  assert.ok(anchor, "anchor present")
  // Mean of {[1,0,0],[0,1,0]} normalized ≈ [0.7071,0.7071,0]. A double-counted [1,0,0] would
  // skew it toward [0.894,0.447,0].
  assert.ok(
    Math.abs(anchor![0] - 0.70710678) < 1e-6 && Math.abs(anchor![1] - 0.70710678) < 1e-6,
    `duplicate must not skew the anchor mean; got ${anchor}`,
  )
})

test("admitAnchor still records a genuinely different page", async () => {
  await clearRelevance()
  await admitAnchor([1, 0, 0])
  await admitAnchor([0, 0, 1]) // distinct, non-consecutive-dup → counted
  const anchor = (await loadRefs()).anchor
  assert.ok(anchor && Math.abs(anchor[0] - anchor[2]) < 1e-6, `both vecs counted; got ${anchor}`)
})

// The anchor is disabled by default (ANCHOR_WINDOW = 0) — the first two tests pin
// that: admitAnchor never writes and loadRefs never surfaces a stored anchor. The
// dormant code path is kept for rollback, so the idempotence contract is still
// tested with an explicit positive window: admitAnchor must ignore a consecutive
// duplicate (the durable dwell is at-least-once, so a teardown-then-reconcile can
// re-judge the same page and re-admit the identical embedding — without dedup that
// page is double-weighted in the anchor mean). Real IndexedDB via fake-indexeddb.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import { ANCHOR_WINDOW, admitAnchor, clearRelevance, loadRefs } from "./relevance.ts"

test("anchor is disabled by default: admitAnchor is a no-op", async () => {
  await clearRelevance()
  assert.equal(ANCHOR_WINDOW, 0)
  await admitAnchor([1, 0, 0]) // default window — must not write
  const anchor = (await loadRefs()).anchor
  assert.equal(anchor, null)
})

test("a pre-disable persisted anchor is ignored by loadRefs", async () => {
  await clearRelevance()
  await admitAnchor([1, 0, 0], 10) // vectors persisted while the anchor was enabled
  assert.equal((await loadRefs()).anchor, null) // default window 0 → ignored
  assert.ok((await loadRefs(10)).anchor, "still readable if the anchor is re-enabled")
})

test("admitAnchor ignores a consecutive duplicate vector (dormant path)", async () => {
  await clearRelevance()
  await admitAnchor([1, 0, 0], 10)
  await admitAnchor([1, 0, 0], 10) // re-judge of the same page (teardown → reconcile) — must be ignored
  await admitAnchor([0, 1, 0], 10)

  const anchor = (await loadRefs(10)).anchor
  assert.ok(anchor, "anchor present")
  // Mean of {[1,0,0],[0,1,0]} normalized ≈ [0.7071,0.7071,0]. A double-counted [1,0,0] would
  // skew it toward [0.894,0.447,0].
  assert.ok(
    Math.abs(anchor![0] - 0.70710678) < 1e-6 && Math.abs(anchor![1] - 0.70710678) < 1e-6,
    `duplicate must not skew the anchor mean; got ${anchor}`,
  )
})

test("admitAnchor still records a genuinely different page (dormant path)", async () => {
  await clearRelevance()
  await admitAnchor([1, 0, 0], 10)
  await admitAnchor([0, 0, 1], 10) // distinct, non-consecutive-dup → counted
  const anchor = (await loadRefs(10)).anchor
  assert.ok(anchor && Math.abs(anchor[0] - anchor[2]) < 1e-6, `both vecs counted; got ${anchor}`)
})

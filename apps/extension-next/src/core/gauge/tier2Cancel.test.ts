import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)

function withPending(over: Partial<GaugeState["pendingTier2"]> = {}): GaugeState {
  return {
    ...initGaugeState(),
    activePageKey: "site/new",
    pendingTier2: { reason: "promotion", tier: 1, pageKey: "site/old", requestedAt: 5000, ...over },
  }
}

test("tier2_cancel releases the pending slot when page + requestedAt match, with no effects", () => {
  const state = withPending()
  const { state: next, effects } = reduceGauge(
    state,
    { type: "tier2_cancel", pageKey: "site/old", requestedAt: 5000, ts: 9000 },
    config,
  )
  assert.equal(next.pendingTier2, null)
  assert.deepEqual(effects, [])
  // It must not touch the (different) active page — no nag, no verdict change.
  assert.equal(next.activePageKey, "site/new")
  assert.equal(next.activeVerdict, null)
})

test("tier2_cancel is a no-op when the pending slot was superseded (requestedAt differs)", () => {
  const state = withPending({ requestedAt: 8000 }) // a newer request now holds the slot
  const { state: next, effects } = reduceGauge(
    state,
    { type: "tier2_cancel", pageKey: "site/old", requestedAt: 5000, ts: 9000 },
    config,
  )
  assert.deepEqual(next.pendingTier2, state.pendingTier2, "newer pending request left intact")
  assert.deepEqual(effects, [])
})

test("tier2_cancel is a no-op when the pageKey does not match", () => {
  const state = withPending()
  const { state: next } = reduceGauge(
    state,
    { type: "tier2_cancel", pageKey: "site/other", requestedAt: 5000, ts: 9000 },
    config,
  )
  assert.deepEqual(next.pendingTier2, state.pendingTier2)
})

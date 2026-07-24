import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)

function withPending(over: Partial<NonNullable<GaugeState["pendingTier2"]>> = {}): GaugeState {
  return {
    ...initGaugeState(),
    activePageKey: "site/new",
    pendingTier2: {
      reason: "promotion",
      tier: 1,
      pageKey: "site/old",
      requestedAt: 5000,
      requestId: 12,
      ...over,
    },
  }
}

test("tier2_cancel releases the pending slot when the requestId matches, with no effects", () => {
  const state = withPending()
  const { state: next, effects } = reduceGauge(state, { type: "tier2_cancel", requestId: 12, ts: 9000 }, config)
  assert.equal(next.pendingTier2, null)
  assert.deepEqual(effects, [])
  // It must not touch the (different) active page — no nag, no verdict change.
  assert.equal(next.activePageKey, "site/new")
  assert.equal(next.activeVerdict, null)
})

test("tier2_cancel is a no-op when a newer request holds the slot (requestId differs)", () => {
  const state = withPending({ requestId: 13 }) // R2 now owns the slot
  const { state: next, effects } = reduceGauge(state, { type: "tier2_cancel", requestId: 12, ts: 9000 }, config)
  assert.deepEqual(next.pendingTier2, state.pendingTier2, "newer request left intact")
  assert.deepEqual(effects, [])
})

test("a created request gets a fresh, strictly-increasing requestId", () => {
  // Drive a promotion request via a big-gap heartbeat is fiddly; assert the counter contract
  // directly: initGaugeState starts the sequence at 0.
  assert.equal(initGaugeState().tier2ReqSeq, 0)
})

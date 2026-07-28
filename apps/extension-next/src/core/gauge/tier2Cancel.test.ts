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

test("each request_tier2 effect carries its OWN requestId when a reduce emits two", () => {
  // A big-gap heartbeat can both promote (accelTransition) and cross S=0 (sZeroGate) in one
  // reduce; the s_zero overwrites the pending slot. Each effect must carry the id it opened
  // with — else the wiring tags both with the final slot's id and mis-routes the superseded one.
  const now = 1_000_000
  const state: GaugeState = {
    ...initGaugeState(),
    s: 8,
    m: 0.4,
    accelTier: 0,
    activeVerdict: "DRIFT",
    activePageKey: "site/a",
    updatedAt: now - 90_000,
    tier2ReqSeq: 0,
  }
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  const reqs = effects.filter((e) => e.type === "request_tier2") as Array<{ requestId: number }>
  assert.ok(reqs.length >= 2, `expected promotion + s_zero in one reduce, got ${reqs.length}`)
  const ids = reqs.map((r) => r.requestId)
  assert.equal(new Set(ids).size, ids.length, "each request_tier2 effect has a distinct requestId")
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [1, 2],
    "ids come from the monotonic counter, promotion then s_zero",
  )
})

test("initGaugeState starts the request counter at 0", () => {
  assert.equal(initGaugeState().tier2ReqSeq, 0)
})

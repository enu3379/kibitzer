// B9: if S drains to 0 while snoozed, the crossing nudge is suppressed and never recurs
// (the crossing edge can't fire again once S is pinned at 0, and maybeRenag needs nagN>=1).
// The S=0 gate must re-fire for a page pinned at 0/DRIFT that was never nudged, once the
// snooze ends — otherwise the user is stuck on an off-goal page with no nudge, forever.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)
const now = 200_000

function pinnedAtZero(over: Partial<GaugeState> = {}): GaugeState {
  return {
    ...initGaugeState(),
    s: 0, // drained to 0 during the snooze
    m: 0.6,
    activeVerdict: "DRIFT",
    degraded: true, // degraded → the S=0 gate nudges directly (no Tier-2 round trip)
    activeMargin: 0.2,
    updatedAt: now - 10_000,
    nagN: 0, // the initial nudge never happened (suppressed while snoozed)
    ...over,
  }
}

test("a page pinned at S=0/DRIFT is nudged once the snooze that suppressed it ends", () => {
  const state = pinnedAtZero({ snoozedUntil: now - 1000 }) // snooze just ended
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(
    effects.some((e) => e.type === "nag"),
    `expected a nag after the snooze ended; got ${JSON.stringify(effects)}`,
  )
})

test("a still-snoozed page pinned at S=0 is NOT nudged", () => {
  const state = pinnedAtZero({ snoozedUntil: now + 60_000 }) // still snoozed
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(!effects.some((e) => e.type === "nag"), "must stay quiet while snoozed")
})

test("the S=0 recovery nudges DIRECTLY and fires once — no request_tier2 storm under churn", () => {
  // Non-degraded, pinned at 0, snooze ended, never nudged, m below the promotion threshold.
  const state = pinnedAtZero({ degraded: false, m: 0.3, snoozedUntil: now - 1000, nagN: 0 })
  const t1 = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(t1.effects.some((e) => e.type === "nag"), "recovery nudges directly")
  assert.ok(
    !t1.effects.some((e) => e.type === "request_tier2"),
    "no Tier-2 request (a churn-cancelled request would re-fire forever)",
  )
  assert.equal(t1.state.nagN, 1, "nagN advances so the initial gate can't re-fire")

  // A later heartbeat (nagN=1 now) must not emit a fresh recovery request either.
  const t2 = reduceGauge(t1.state, { type: "heartbeat", ts: now + 1000 }, config)
  assert.ok(!t2.effects.some((e) => e.type === "request_tier2"), "still no request storm")
})

test("a page already nudged (nagN>=1) does not re-fire the initial S=0 gate", () => {
  // Non-degraded so the initial gate would emit request_tier2 (distinct from a debt-based
  // renag "nag"); m below the promotion threshold so accelTransition doesn't emit its own
  // request_tier2. With nagN>=1 the initial S=0 gate must stay silent — further nudging is
  // maybeRenag's job, not a fresh initial request.
  const state = pinnedAtZero({ degraded: false, m: 0.3, snoozedUntil: now - 1000, nagN: 1, lastNagTs: now - 5000 })
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(!effects.some((e) => e.type === "request_tier2"), "no fresh initial request when already nudged")
})

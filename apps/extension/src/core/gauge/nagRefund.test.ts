// A nag is counted when it is EMITTED, but the wiring delivers it afterwards and can legitimately
// fail. `nag_undelivered` hands the count back, so a nudge nobody saw does not spend a rung of the
// re-nag backoff ladder — and, when it was the episode's first, does not shut the S=0 recovery
// gate (which requires nagN === 0) for the rest of the episode.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)
const now = 200_000
const refund = { type: "nag_undelivered", ts: now } as const

function nudged(over: Partial<GaugeState> = {}): GaugeState {
  return {
    ...initGaugeState(),
    s: 0,
    m: 0.6,
    activeVerdict: "DRIFT",
    degraded: true, // no Tier-2 round trip: the S=0 gates nudge directly
    activeMargin: 0.2,
    activePageKey: "site/a",
    updatedAt: now - 10_000,
    nagN: 1, // a nag was emitted…
    // …and zeroed the debt on its way out; drift since then has rebuilt a little. NOT zero on
    // purpose: the one scope decision this change rests on is that the debt is *not* restored,
    // and a fixture of 0 would let a version that restores it pass unnoticed.
    renagDebt: 37,
    lastNagTs: now - 10_000,
    ...over,
  }
}

test("the count comes back, and nothing else moves", () => {
  const before = nudged()
  const { state, effects } = reduceGauge(before, refund, config)
  assert.equal(state.nagN, 0, "the nudge nobody saw is no longer counted")
  assert.equal(state.nagRefunded, true, "and the episode's one refund is now spent")
  assert.deepEqual(effects, [], "a correction emits nothing")
  // Deliberately NOT restored: the debt stays where the nag left it, so this reopens the recovery
  // path rather than making a re-nag due on the spot.
  assert.equal(state.renagDebt, before.renagDebt)
  assert.equal(state.lastNagTs, before.lastNagTs)
  // Not a passage of time — no integration, no clock rebase.
  assert.equal(state.s, before.s)
  assert.equal(state.m, before.m)
  assert.equal(state.updatedAt, before.updatedAt)
})

test("only one refund per episode — an undeliverable page cannot loop on it", () => {
  // Without the latch: nudge → lost → refund → the gate re-fires next heartbeat → lost → refund →
  // … once a minute forever, playing a chime each time on the surfaces that chime before failing.
  const once = reduceGauge(nudged(), refund, config).state
  const twice = reduceGauge({ ...once, nagN: 1 }, refund, config).state
  assert.equal(twice.nagN, 1, "the second loss is accepted as real silence")
})

test("gives back exactly one rung, from wherever the ladder is", () => {
  // Every other case here starts at nagN 1, where "minus one" and "back to zero" look identical.
  // A lost RE-nag has to land on the rung below, not on the floor.
  const { state } = reduceGauge(nudged({ nagN: 3 }), refund, config)
  assert.equal(state.nagN, 2)
})

test("a refund with nothing to give back is a no-op", () => {
  const { state } = reduceGauge(nudged({ nagN: 0 }), refund, config)
  assert.equal(state.nagN, 0, "never negative")
  assert.equal(state.nagRefunded, false, "and the allowance is not spent on nothing")
})

test("a fresh episode may restore a nudge again", () => {
  // The allowance resets with nagN and the debt when the drift episode ends (m <= 0).
  const spent = reduceGauge(nudged(), refund, config).state
  const recovered = reduceGauge(
    { ...spent, activeVerdict: "OK", m: -0.1, updatedAt: now },
    { type: "heartbeat", ts: now + 1000 },
    config,
  ).state
  assert.equal(recovered.nagRefunded, false)
})

test("REGRESSION: losing the episode's first nudge no longer shuts the S=0 gate", () => {
  // The gate that rescues a page pinned at 0/DRIFT with nothing shown requires nagN === 0. An
  // emitted-but-undelivered first nag flipped it to 1, so the gate closed, the crossing could not
  // recur (S is already 0), and only the debt-based re-nag was left — ~6 minutes of further drift
  // at the defaults. Total silence in the meantime.
  const lost = nudged() // first nag emitted, never surfaced
  const withoutRefund = reduceGauge(lost, { type: "heartbeat", ts: now }, config)
  assert.deepEqual(withoutRefund.effects, [], "still mute while the count says it was nudged")

  const refunded = reduceGauge(lost, refund, config).state
  const afterRefund = reduceGauge(refunded, { type: "heartbeat", ts: now }, config)
  assert.ok(
    afterRefund.effects.some((e) => e.type === "nag"),
    `the very next heartbeat retries instead; got ${JSON.stringify(afterRefund.effects)}`,
  )
  assert.equal(afterRefund.state.nagN, 1, "and that retry is counted normally")
})

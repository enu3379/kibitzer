// Quiet hours as a reducer-level silence, not a delivery-time drop.
//
// The window used to be consulted only when a nudge was about to be shown. The gauge kept
// DECIDING nudges through the night, and each decision spent a rung of the re-nag ladder
// (nagN + 1, renagDebt = 0). Eight hours of that pins the backoff at its ceiling, so the silence
// the user asked for is followed by up to 48 minutes of silence they did not.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)
const now = 500_000

function drifting(over: Partial<GaugeState> = {}): GaugeState {
  return {
    ...initGaugeState(),
    s: 0.5, // one beat from the floor
    m: 0.6,
    activeVerdict: "DRIFT",
    degraded: true, // the S=0 gate nudges directly, with no judge round trip
    activeMargin: 0.2,
    activePageKey: "site/a",
    updatedAt: now - 60_000,
    ...over,
  }
}

const beat = (state: GaugeState, at: number, quiet?: boolean) =>
  reduceGauge(state, { type: "heartbeat", quiet, ts: at }, config)

test("nothing is decided inside the window", () => {
  const { state, effects } = beat(drifting(), now, true)
  assert.deepEqual(effects, [], "no nudge is decided while the user has asked for silence")
  assert.equal(state.s, 0, "the drift is still measured — silence is not forgiveness")
  assert.equal(state.nagN, 0, "and no rung of the backoff ladder is spent")
})

test("the flag persists across ticks and is only re-stamped when carried", () => {
  const entered = beat(drifting(), now, true).state
  // A tick with no `quiet` field keeps the stored value, the same way `nav` treats `degraded`.
  const { state, effects } = beat(entered, now + 60_000)
  assert.equal(state.quiet, true)
  assert.deepEqual(effects, [], "still silent")
})

test("the tick that carries the news is already governed by it", () => {
  // Re-stamping AFTER integrating would let the boundary tick decide one last nudge under the
  // old value — the user's first quiet-hours minute would still get nudged.
  const { effects } = beat(drifting({ quiet: false }), now, true)
  assert.deepEqual(effects, [], "entering the window silences the very tick that reports it")
})

test("REGRESSION: the window leaves the backoff untouched, so leaving it nudges at once", () => {
  // Eight hours of drift inside the window. Before this change every beat that met the re-nag
  // threshold fired, walking nagN up and pinning the backoff at rRenagMax.
  let st = drifting()
  for (let i = 1; i <= 8 * 60; i += 1) st = beat(st, now + i * 60_000, true).state
  assert.equal(st.nagN, 0, "eight hours of silence cost nothing")
  assert.ok(st.renagDebt > 0, "the drift debt still accrued")

  // The window ends. The S=0 recovery gate (nagN === 0) fires on the next beat.
  const { effects } = beat(st, now + (8 * 60 + 1) * 60_000, false)
  assert.ok(
    effects.some((e) => e.type === "nag"),
    `the first beat after the window nudges; got ${JSON.stringify(effects)}`,
  )
})

test("an explicit snooze still silences on its own", () => {
  // `silenced` is snooze OR quiet — quiet hours widened the gate, it did not replace it.
  const { effects } = beat(drifting({ snoozedUntil: now + 60_000 }), now, false)
  assert.deepEqual(effects, [], "a running snooze is unaffected by the quiet flag being false")
})

test("outside the window the gauge nudges exactly as before", () => {
  const { effects, state } = beat(drifting(), now, false)
  assert.ok(effects.some((e) => e.type === "nag"), "S=0 on an off-goal page still nudges")
  assert.equal(state.nagN, 1)
})

test("acceleration is not part of the silence", () => {
  // Quiet hours means "do not nudge me", not "stop measuring me". Promotion escalates the drain
  // tier and never nudges, so it keeps running — only the nudge-deciding gates are widened.
  // Non-degraded so promotion goes through a Tier-2 request, and m above tUp[0] so it is due.
  const { effects } = beat(
    drifting({ degraded: false, activeMargin: null, m: 0.7, s: 60, quiet: true }),
    now,
    true,
  )
  const request = effects.find((e) => e.type === "request_tier2")
  assert.equal(request?.reason, "promotion", `expected a promotion request; got ${JSON.stringify(effects)}`)
  assert.ok(!effects.some((e) => e.type === "nag"), "but still no nudge")
})

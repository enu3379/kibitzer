// Pins the degraded-mode S=0 nag invariant that the flaky E2E made us doubt. An E2E
// ("goal → drift → S drains to 0 → nag delivered") intermittently ended with S=0 but six
// "celebration" toasts and zero "intervention" nags — which looked like the gauge celebrating
// a page it should have nagged. Adversarial reducer fuzzing showed the reducer is sound: on a
// page whose verdict STAYS DRIFT, `s` is monotonically non-increasing, so a celebration (which
// needs `s` to rise back past cCelebrate while armed) is impossible — the six celebrations could
// only come from a verdict that OSCILLATED, which the E2E's mocked-Date/real-WASM ordering
// injected. The fix was to harden the E2E's timing, not the reducer. These tests keep that
// conclusion honest: if a future change ever lets a DRIFT-only page celebrate, or drops the S=0
// nag, they fail here at the pure-reducer level instead of flaking in the E2E.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState, type GaugeEvent, type GaugeEffect } from "./types.ts"

const config = defaultGaugeConfig(null) // null budget → tBudget 900s

/** A degraded, DRIFT, active page. activeMargin=null → marginWeight w=1 (fastest drain). */
function degradedDrift(over: Partial<GaugeState> = {}): GaugeState {
  return {
    ...initGaugeState(),
    s: 100,
    m: 0,
    activePageKey: "p",
    activeVerdict: "DRIFT",
    degraded: true,
    activeMargin: null,
    updatedAt: 0,
    ...over,
  }
}

function run(state: GaugeState, events: GaugeEvent[]): { st: GaugeState; effects: GaugeEffect[] } {
  let st = state
  const effects: GaugeEffect[] = []
  for (const ev of events) {
    const t = reduceGauge(st, ev, config)
    st = t.state
    effects.push(...t.effects)
  }
  return { st, effects }
}

const count = (e: GaugeEffect[], type: string): number => e.filter((x) => x.type === type).length

test("degraded DRIFT drained to 0 by heartbeats fires a nag and never celebrates", () => {
  const hbs: GaugeEvent[] = []
  for (let i = 1; i <= 40; i += 1) hbs.push({ type: "heartbeat", ts: i * 60_000 })
  const { st, effects } = run(degradedDrift(), hbs)
  assert.equal(st.s, 0, "S bottomed out")
  assert.equal(st.activeVerdict, "DRIFT")
  assert.ok(count(effects, "nag") >= 1, `expected a nag, got ${count(effects, "nag")}`)
  assert.equal(count(effects, "celebrate"), 0, "a page that never recovers must not celebrate")
})

test("a page whose verdict stays DRIFT never celebrates — even after arming (s ≤ cArm)", () => {
  // Drain well past the celebrate-arm threshold, then keep affirming DRIFT for a long time.
  const events: GaugeEvent[] = []
  for (let i = 1; i <= 200; i += 1) events.push({ type: "heartbeat", ts: i * 60_000 })
  const { st, effects } = run(degradedDrift(), events)
  assert.ok(st.celebrateArmed || st.s === 0, "the run armed the celebration or bottomed out")
  assert.equal(count(effects, "celebrate"), 0, "celebration is impossible on a monotonically draining page")
})

test("fuzz: 1000 random DRIFT-only sequences keep the invariant (nag by S=0, never celebrate)", () => {
  let seed = 0x9e3779b9
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  let violations = 0
  let first: unknown = null
  for (let trial = 0; trial < 1000; trial += 1) {
    let st = degradedDrift({ m: rnd() * 2 - 1 })
    let ts = 0
    let cumNag = 0
    let cumCel = 0
    const steps = 5 + Math.floor(rnd() * 40)
    for (let k = 0; k < steps; k += 1) {
      ts += Math.floor(rnd() * 200_000) // 0..200s gaps, sometimes past gapCap
      const roll = rnd()
      const ev: GaugeEvent =
        roll < 0.7
          ? { type: "heartbeat", ts }
          : roll < 0.85
            ? { type: "nav", pageKey: "p", verdict: "DRIFT", degraded: true, ts }
            : roll < 0.92
              ? { type: "inactive", ts }
              : { type: "heartbeat", ts: ts - Math.floor(rnd() * 50_000) } // out-of-order
      const t = reduceGauge(st, ev, config)
      st = t.state
      cumNag += count(t.effects, "nag")
      cumCel += count(t.effects, "celebrate")
      const snoozed = st.snoozedUntil != null && ts < st.snoozedUntil
      if (st.activeVerdict === "DRIFT" && st.s === 0 && !snoozed && cumNag < 1) {
        violations += 1
        first ??= { trial, k, ts, kind: "no-nag-at-zero" }
      }
      if (cumCel > 0) {
        violations += 1
        first ??= { trial, k, kind: "celebrate-on-drift" }
      }
    }
  }
  assert.equal(violations, 0, `fuzz violations: ${violations} first=${JSON.stringify(first)}`)
})

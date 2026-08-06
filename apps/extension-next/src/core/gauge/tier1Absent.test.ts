// Pins the tier1Absent contract (issue #207 "F"): when Tier 1's route resolves to no provider,
// the Tier-0 verdict being integrated had no rescue filter, so the gauge borrows degraded mode's
// margin-confidence weight — and ONLY the weight. The other two degraded behaviors (accel
// auto-promotion, the unconfirmed S=0 nag) must stay keyed on `degraded` alone: Tier 2 is alive
// in this configuration, so every nag is still confirmed first. These tests fail if the flag
// ever starts to mean more than "slow the gauge near the threshold", or stops meaning that.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeEffect, type GaugeEvent, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null) // tBudget 900s → rDrain = rRecover = 1/9 per s
const TAU = 0.59

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

/** One judged nav then one 60s heartbeat — the smallest sequence that integrates a verdict. */
function navThenBeat(nav: Partial<Extract<GaugeEvent, { type: "nav" }>>, s0 = 100): { st: GaugeState; effects: GaugeEffect[] } {
  return run({ ...initGaugeState(), s: s0 }, [
    { type: "nav", pageKey: "p", verdict: "DRIFT", ts: 0, ...nav } as GaugeEvent,
    { type: "heartbeat", ts: 60_000 },
  ])
}

const count = (e: GaugeEffect[], type: string): number => e.filter((x) => x.type === type).length

test("marginal-score DRIFT drains slower with tier1Absent than without", () => {
  // r0 sits 0.05 under tauOk: w = (0.05/0.25)^3 = 0.008 — a barely-DRIFT page should barely move.
  const damped = navThenBeat({ r0: TAU - 0.05, tauOk: TAU, tier1Absent: true })
  const full = navThenBeat({ r0: TAU - 0.05, tauOk: TAU })
  assert.equal(full.st.activeMargin, null, "without the flag (and not degraded) no margin is stored")
  assert.ok(Math.abs((damped.st.activeMargin ?? 0) - 0.05) < 1e-9, "the flag stores the margin")
  const dampedDrain = 100 - damped.st.s
  const fullDrain = 100 - full.st.s
  assert.ok(dampedDrain < fullDrain, `damped drain ${dampedDrain} must be below full ${fullDrain}`)
  assert.ok(Math.abs(dampedDrain - fullDrain * 0.008) < 1e-9, "damped by exactly (|margin|/M)^p")
  assert.ok(Math.abs(damped.st.m - full.st.m * 0.008) < 1e-9, "inertia is weighted identically")
})

test("far-from-threshold DRIFT drains at full weight (marginWeight saturates at 1)", () => {
  // Margin 0.30 ≥ M=0.25 → the clamp returns 1: an unambiguous drift is not softened.
  const flagged = navThenBeat({ r0: TAU - 0.3, tauOk: TAU, tier1Absent: true })
  const unflagged = navThenBeat({ r0: TAU - 0.3, tauOk: TAU })
  assert.equal(flagged.st.s, unflagged.st.s)
  assert.equal(flagged.st.m, unflagged.st.m)
})

test("recovery on a marginal OK is weighted exactly as degraded mode weights it", () => {
  // The recovery gain feeds the weighted inertia back into (1-m)/K and the boost, so the exact
  // damped value is pinned by equivalence with a degraded run over the same events — the spec is
  // "the same weight degraded applies", not a closed-form ratio.
  const damped = navThenBeat({ verdict: "OK", r0: TAU + 0.05, tauOk: TAU, tier1Absent: true }, 50)
  const degraded = navThenBeat({ verdict: "OK", r0: TAU + 0.05, tauOk: TAU, degraded: true }, 50)
  const full = navThenBeat({ verdict: "OK", r0: TAU + 0.05, tauOk: TAU }, 50)
  const dampedGain = damped.st.s - 50
  const fullGain = full.st.s - 50
  assert.ok(dampedGain > 0 && fullGain > 0, "both recover")
  assert.ok(dampedGain < fullGain, "a barely-OK page recovers slower when nothing filtered Tier 0")
  assert.equal(damped.st.s, degraded.st.s, "same integration weight as degraded")
  assert.equal(damped.st.m, degraded.st.m)
})

test("flag off — and absent on a pre-field checkpoint — is exactly current behavior", () => {
  // A checkpoint written before tier1Absent existed deserializes without the field.
  const legacy = { ...initGaugeState() } as Partial<GaugeState>
  delete legacy.tier1Absent
  const fromLegacy = run(legacy as GaugeState, [
    { type: "nav", pageKey: "p", verdict: "DRIFT", r0: TAU - 0.05, tauOk: TAU, ts: 0 },
    { type: "heartbeat", ts: 60_000 },
  ])
  const current = navThenBeat({ r0: TAU - 0.05, tauOk: TAU })
  assert.equal(fromLegacy.st.s, current.st.s)
  assert.equal(fromLegacy.st.m, current.st.m)
  assert.equal(fromLegacy.st.activeMargin, null)
})

test("tier1Absent with no margin available falls back to full weight, like degraded", () => {
  // A nav that carries the flag but no r0/tauOk (e.g. a user-override OK re-judged later):
  // marginWeight has nothing to weigh by and must not stall the gauge at zero speed.
  const noMargin = navThenBeat({ tier1Absent: true })
  const baseline = navThenBeat({})
  assert.equal(noMargin.st.s, baseline.st.s)
})

test("tier1Absent alone does NOT auto-promote — promotion still asks Tier 2", () => {
  const beats = (n: number): GaugeEvent[] =>
    Array.from({ length: n }, (_, i) => ({ type: "heartbeat", ts: (i + 1) * 60_000 }))
  // Four 60s beats push m past tUp[0]=0.5 (0.181, 0.330, 0.451, 0.551). No r0 → full speed.
  const confirmFirst = run(initGaugeState(), [
    { type: "nav", pageKey: "p", verdict: "DRIFT", tier1Absent: true, ts: 0 },
    ...beats(4),
  ])
  assert.equal(confirmFirst.st.accelTier, 0, "no silent promotion while Tier 2 can confirm")
  assert.ok(
    confirmFirst.effects.some((e) => e.type === "request_tier2" && e.reason === "promotion"),
    "the crossing produces a Tier-2 promotion request instead",
  )
  const degraded = run(initGaugeState(), [
    { type: "nav", pageKey: "p", verdict: "DRIFT", degraded: true, ts: 0 },
    ...beats(4),
  ])
  assert.equal(degraded.st.accelTier, 1, "degraded (both tiers absent) still auto-promotes")
  assert.equal(count(degraded.effects, "request_tier2"), 0)
})

test("tier1Absent alone does NOT nag unconfirmed at S=0 — a request_tier2 still appears", () => {
  const beats = (n: number): GaugeEvent[] =>
    Array.from({ length: n }, (_, i) => ({ type: "heartbeat", ts: (i + 1) * 60_000 }))
  // 20 full-speed beats drain 100 well past S=0 (rDrain*60 ≈ 6.7 per beat).
  const confirmFirst = run(initGaugeState(), [
    { type: "nav", pageKey: "p", verdict: "DRIFT", tier1Absent: true, ts: 0 },
    ...beats(20),
  ])
  assert.equal(confirmFirst.st.s, 0, "the gauge bottomed out")
  assert.equal(count(confirmFirst.effects, "nag"), 0, "no unconfirmed nag with Tier 2 alive")
  assert.ok(
    confirmFirst.effects.some((e) => e.type === "request_tier2" && e.reason === "s_zero"),
    "S=0 still asks Tier 2 to confirm",
  )
  const degraded = run(initGaugeState(), [
    { type: "nav", pageKey: "p", verdict: "DRIFT", degraded: true, ts: 0 },
    ...beats(20),
  ])
  assert.ok(count(degraded.effects, "nag") >= 1, "degraded still nags directly at S=0")
})

test("the already-at-zero gate confirms via Tier 2 under tier1Absent, never nags directly", () => {
  // The downward-crossing test above never exercises the already-at-zero branch under the flag:
  // the crossing's own s_zero request stays pending and short-circuits it. Arrive on a fresh
  // drifting page with S ALREADY 0 and the pending slot free — the third direct-nag site
  // (`degraded || freshDrift` inside advance) must not gain a tier1Absent arm.
  const alreadyZero: GaugeState = {
    ...initGaugeState(),
    s: 0,
    activePageKey: "p",
    activeVerdict: "DRIFT",
    tier1Absent: true,
    updatedAt: 0,
  }
  const { st, effects } = run(alreadyZero, [{ type: "heartbeat", ts: 60_000 }])
  assert.equal(st.s, 0)
  assert.equal(count(effects, "nag"), 0, "no unconfirmed nag from the already-at-zero gate")
  assert.ok(
    effects.some((e) => e.type === "request_tier2" && e.reason === "s_zero"),
    "the gate asks Tier 2 instead",
  )
  const degradedZero = run({ ...alreadyZero, tier1Absent: false, degraded: true }, [
    { type: "heartbeat", ts: 60_000 },
  ])
  assert.ok(count(degradedZero.effects, "nag") >= 1, "degraded's direct nag at this gate is kept")
})

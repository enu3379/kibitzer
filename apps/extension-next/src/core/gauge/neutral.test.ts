// The `neutral` event (dwell-hold). When a new page is observed but not yet judged, the gauge
// must stop integrating the previous page's verdict — neither drain nor recover — until the
// dwell's `nav` supplies the fresh verdict, at which point integration resumes WITHOUT
// back-integrating the frozen interval. Guards the "stale DRIFT keeps draining while the user
// reads on-goal pages whose judges were dropped" regression.

import assert from "node:assert/strict"
import test from "node:test"

import { reduceGauge } from "./reducer.ts"
import { defaultGaugeConfig } from "./config.ts"
import { initGaugeState, type GaugeState } from "./types.ts"

const config = defaultGaugeConfig(null)

function drifting(over: Partial<GaugeState> = {}): GaugeState {
  return { ...initGaugeState(), s: 80, activeVerdict: "DRIFT", activePageKey: "comic", updatedAt: 0, ...over }
}

test("neutral integrates the just-left page up to the nav, then drops the verdict", () => {
  const state = drifting()
  // 60s of drift on `comic` still counts, up to the instant they navigate.
  const { state: next } = reduceGauge(state, { type: "neutral", pageKey: "news", ts: 60_000 }, config)
  assert.ok(next.s < 80, `the drift up to the navigation still drains (S=${next.s})`)
  assert.equal(next.activeVerdict, null, "verdict is dropped — the new page isn't judged yet")
  assert.equal(next.activePageKey, "news", "the active page moves to the page now being observed")
  assert.equal(next.activeMargin, null, "the stale degraded margin is cleared")
})

test("a heartbeat while NEUTRAL freezes S and m (no drain, no recover)", () => {
  const held = reduceGauge(drifting(), { type: "neutral", pageKey: "news", ts: 0 }, config).state
  const sHeld = held.s
  const mHeld = held.m
  // Two minutes of heartbeats pass while the dwell is still judging.
  let st = held
  for (const ts of [60_000, 120_000]) st = reduceGauge(st, { type: "heartbeat", ts }, config).state
  assert.equal(st.s, sHeld, "S must not move while neutral")
  assert.equal(st.m, mHeld, "m must not move while neutral")
  assert.equal(st.updatedAt, 120_000, "the clock is still rebased so the hold isn't back-integrated later")
})

test("nav after a neutral hold resumes integration from the nav, not the hold start", () => {
  // Freeze at t=0, sit neutral for 2 min, then the judge lands OK.
  let st = reduceGauge(drifting({ s: 40 }), { type: "neutral", pageKey: "news", ts: 0 }, config).state
  st = reduceGauge(st, { type: "heartbeat", ts: 120_000 }, config).state
  const sBeforeNav = st.s
  st = reduceGauge(st, { type: "nav", pageKey: "news", verdict: "OK", ts: 120_000 }, config).state
  assert.equal(st.activeVerdict, "OK")
  assert.equal(st.s, sBeforeNav, "the nav itself integrates nothing (delta 0 from the rebased clock)")
  // One more minute on the OK page recovers — and only ~1 min of recovery, not the frozen 3 min.
  const recovered = reduceGauge(st, { type: "heartbeat", ts: 180_000 }, config).state
  assert.ok(recovered.s > sBeforeNav, `recovery resumes once judged (S ${sBeforeNav} → ${recovered.s})`)
})

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

// Leaving a page settles it but decides NOTHING about it. Anything decided here would name a
// page that is already off the screen, so it could only be delivered on top of whatever the user
// just opened — a comment about page A on innocent page B. The debt is carried instead, so the
// page they land on can nudge under its own verdict as soon as that verdict exists.

test("leaving a page never nags about it, however far the settlement drains S", () => {
  // Degraded so the S=0 gate would nudge on the spot rather than asking a judge, and low enough
  // that the settlement is certain to cross zero.
  const leaving = reduceGauge(
    drifting({ s: 0.5, degraded: true, m: 0.6, activeMargin: 0.2 }),
    { type: "neutral", pageKey: "news", ts: 60_000 },
    config,
  )
  assert.equal(leaving.state.s, 0, "the drift up to the navigation still drains S to the floor")
  assert.deepEqual(leaving.effects, [], "but nothing is decided about the page being left")
})

test("leaving does not spend the nag budget — the page they land on can still be nudged", () => {
  // The bookkeeping half. A nag emitted here would be dropped at delivery (it has nowhere valid
  // to show), yet nagN/renagDebt would still record it as sent — and the next page could then
  // not be nudged until the re-nag debt rebuilt, minutes later.
  const leaving = reduceGauge(
    drifting({ s: 0.5, degraded: true, m: 0.6, activeMargin: 0.2 }),
    { type: "neutral", pageKey: "news", ts: 60_000 },
    config,
  ).state
  assert.equal(leaving.nagN, 0, "no nag was sent, so none is counted")
  assert.ok(leaving.renagDebt > 0, "the drift debt is carried, not forgiven")

  // The new page is judged off-goal: it is nudged straight away, on its own verdict.
  const judged = reduceGauge(leaving, { type: "nav", pageKey: "news", verdict: "DRIFT", ts: 60_000 }, config).state
  const { effects } = reduceGauge(judged, { type: "heartbeat", ts: 70_000 }, config)
  const nag = effects.find((e) => e.type === "nag")
  assert.equal(nag?.pageKey, "news", `expected a nag for the page now open; got ${JSON.stringify(effects)}`)
})

test("leaving does not fire a RE-nag about the page being left either", () => {
  // The debt-based re-nag needs nagN >= 1, so every case above (nagN 0) is blind to it — yet a
  // user already nudged once is exactly who it targets, and it fired on the settlement just like
  // the S=0 gate did. Debt starts past the first threshold (rRenag = 40) so it is due right now.
  const leaving = reduceGauge(
    drifting({ nagN: 1, renagDebt: 45, lastNagTs: 0 }),
    { type: "neutral", pageKey: "news", ts: 60_000 },
    config,
  )
  assert.deepEqual(leaving.effects, [], "no re-nag about a page the user has left")
  assert.equal(leaving.state.nagN, 1, "the re-nag schedule is untouched, not consumed")
  assert.ok(leaving.state.renagDebt > 45, "and the debt keeps growing, so the next page is due one")
})

test("leaving does not open a Tier-2 request for the abandoned page", () => {
  // Not just wasted: the request would hold the single pending slot until it was cancelled,
  // delaying the confirmation the page they actually land on needs.
  const leaving = reduceGauge(
    drifting({ s: 0.5, m: 0.9 }), // m high enough to also tempt a promotion request
    { type: "neutral", pageKey: "news", ts: 60_000 },
    config,
  )
  assert.deepEqual(leaving.effects, [], "no request_tier2 for a page the user has left")
  assert.equal(leaving.state.pendingTier2, null, "and the slot stays free for the next page")
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

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

test("the S=0 recovery CONFIRMS via Tier-2 rather than nudging unconfirmed", () => {
  // Non-degraded, pinned at 0, snooze ended, never nudged, m below the promotion threshold (so
  // any request here is the recovery gate's, not a promotion's).
  //
  // This gate used to nudge directly, trading a possible false alarm for never missing a real
  // drift. The product wants the opposite trade — a missed nudge is acceptable, an unconfirmed
  // one is not — so it now asks Tier-2 first, exactly like the downward-crossing gate.
  const state = pinnedAtZero({ degraded: false, m: 0.3, snoozedUntil: now - 1000, nagN: 0 })
  const t1 = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(!t1.effects.some((e) => e.type === "nag"), "no nag before Tier-2 has confirmed")
  const request = t1.effects.find((e) => e.type === "request_tier2")
  assert.equal(request?.reason, "s_zero", `expected an s_zero confirmation; got ${JSON.stringify(t1.effects)}`)
  assert.equal(request?.useWriter, true, "the episode's FIRST confirmation pays for the Writer")
  assert.equal(t1.state.nagN, 0, "nagN advances only when a nag actually fires (on the verdict)")

  // The pending slot holds the gate shut for this page, so heartbeats can't storm requests
  // while the judge is still out.
  const t2 = reduceGauge(t1.state, { type: "heartbeat", ts: now + 1000 }, config)
  assert.ok(!t2.effects.some((e) => e.type === "request_tier2"), "no second request while one is pending")
})

test("degraded mode still nudges DIRECTLY — there is no Tier-2 to confirm with", () => {
  // Without a judge the confirmation would fail open to "ok" and the user would be nudged
  // NEVER. pinnedAtZero() is degraded by default; assert the recovery gate itself, not the
  // crossing (S is already 0).
  const state = pinnedAtZero({ m: 0.3, snoozedUntil: now - 1000, nagN: 0 })
  const { effects, state: next } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(effects.some((e) => e.type === "nag"), "degraded nudges without a round trip")
  assert.ok(!effects.some((e) => e.type === "request_tier2"), "and never asks a judge it does not have")
  assert.equal(next.nagN, 1)
})

test("a fresh Tier-2 DRIFT verdict for this page nudges directly — no redundant confirmation", () => {
  const state = pinnedAtZero({
    degraded: false,
    m: 0.3,
    snoozedUntil: now - 1000,
    nagN: 0,
    activePageKey: "site/a",
    lastJudgment: { pageKey: "site/a", flow: "drift", ts: now - 1000 }, // Tier-2 just said drift
  })
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(effects.some((e) => e.type === "nag"), "a cached drift verdict IS the confirmation")
  assert.ok(!effects.some((e) => e.type === "request_tier2"), "so it does not ask again")
})

test("repeat confirmations in one episode drop the Writer, and a new episode restores it", () => {
  // The page-hopping case: every confirmation resolves after the user has moved on, so nagN
  // never advances and the gate re-asks on the next page. Only the first asks for a written
  // message; the repeats take the persona preset so the round trip they keep out-navigating is
  // half as long.
  const first = reduceGauge(
    pinnedAtZero({ degraded: false, m: 0.3, snoozedUntil: now - 1000, nagN: 0 }),
    { type: "heartbeat", ts: now },
    config,
  )
  assert.equal(first.effects.find((e) => e.type === "request_tier2")?.useWriter, true)

  // The user out-navigates it: the slot is released (tier2_cancel) with nagN still 0, and the
  // next page drains to 0 and asks again.
  const released = reduceGauge(
    first.state,
    { type: "tier2_cancel", requestId: first.state.pendingTier2!.requestId, ts: now + 1000 },
    config,
  ).state
  const second = reduceGauge(released, { type: "heartbeat", ts: now + 2000 }, config)
  assert.equal(
    second.effects.find((e) => e.type === "request_tier2")?.useWriter,
    false,
    "the repeat takes the preset",
  )

  // Recovering on-goal ends the episode (m <= 0), which restores the Writer budget along with
  // the re-nag schedule.
  const recovered = reduceGauge(
    { ...second.state, activeVerdict: "OK", m: -0.1 },
    { type: "heartbeat", ts: now + 3000 },
    config,
  ).state
  assert.equal(recovered.sZeroConfirms, 0, "a fresh episode may pay for the Writer again")
})

test("the S=0 recovery respects a fresh Tier-2 OK for the active page (no nudge)", () => {
  const state = pinnedAtZero({
    degraded: false,
    m: 0.3,
    snoozedUntil: now - 1000,
    nagN: 0,
    activePageKey: "site/a",
    lastJudgment: { pageKey: "site/a", flow: "ok", ts: now - 1000 }, // Tier-2 just said OK
  })
  const { effects } = reduceGauge(state, { type: "heartbeat", ts: now }, config)
  assert.ok(!effects.some((e) => e.type === "nag"), "a page Tier-2 just confirmed OK is not recovery-nagged")
  // Asserting only "no nag" went vacuous once the gate started asking instead of nudging: an
  // unguarded gate emits request_tier2 and no nag, and would pass. The point of the cached OK is
  // that the gate does nothing AT ALL — including not paying to re-ask what was just answered.
  assert.ok(!effects.some((e) => e.type === "request_tier2"), "and is not re-confirmed either")
})

test("a checkpoint written before sZeroConfirms existed still pays for the Writer once", () => {
  // GaugeState is loaded straight out of IndexedDB and isGaugeState() does not validate this
  // field, so an upgrade meets `undefined` here. Without the `?? 0` default the counter becomes
  // NaN — never === 0 — pinning every confirmation for the rest of the session to the preset.
  const legacy = pinnedAtZero({ degraded: false, m: 0.3, snoozedUntil: now - 1000, nagN: 0 })
  delete (legacy as { sZeroConfirms?: number }).sZeroConfirms
  const { effects, state } = reduceGauge(legacy, { type: "heartbeat", ts: now }, config)
  assert.equal(effects.find((e) => e.type === "request_tier2")?.useWriter, true)
  assert.equal(state.sZeroConfirms, 1, "the counter resumes from 0, not from NaN")
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

// reduceGauge — the pure gauge reducer (contract §5–§6). No clock, storage,
// network, or notification access: "now" arrives only as event.ts (epoch ms).
// Same (state, event, config) always yields the same GaugeTransition.
//
// Cross-checked for byte-parity against the Python B track (gauge.py) over the
// shared fixtures AND the lifecycle benchmark trace. Operation order per §5:
// inertia → accel transition → integrate → celebration → episode reset → S=0 gate.

import type {
  GaugeConfig,
  GaugeEffect,
  GaugeEvent,
  GaugeState,
  GaugeTransition,
} from "./types.ts";

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Degraded-mode speed multiplier f(margin) = clamp((|margin|/M)^p, 0, 1). With no
 *  margin available, fall back to full weight (1.0) — matches the Python track. */
function marginWeight(state: GaugeState, config: GaugeConfig): number {
  if (state.activeMargin == null || config.degradedM <= 0) return 1.0;
  return clamp(Math.pow(Math.abs(state.activeMargin) / config.degradedM, config.degradedP), 0, 1);
}

function snoozed(state: GaugeState, now: number): boolean {
  return state.snoozedUntil != null && now < state.snoozedUntil;
}

/** The user does not want to be nudged right now — an explicit snooze, or their quiet hours.
 *
 *  Quiet hours used to be consulted only at delivery, so the gauge went on DECIDING nudges all
 *  night and each one spent a rung of the re-nag ladder. Eight hours of that pins the backoff at
 *  its ceiling, and the silence the user asked for is followed by 48 minutes of silence they did
 *  not. Deciding nothing is what makes the window free.
 *
 *  `quiet` is refreshed by the heartbeat, so it can lag the real window by up to a tick — the
 *  delivery-time check stays as the exact gate. */
function silenced(state: GaugeState, now: number): boolean {
  // `=== true`, not a bare read: a checkpoint written before this field existed has `undefined`
  // here, and the declared boolean would be a lie at runtime (same shape as sZeroConfirms ?? 0).
  return snoozed(state, now) || state.quiet === true;
}

/** Discrete acceleration-tier transition with hysteresis (§5). Demotion first and
 *  mutually exclusive (a step moves m one way). Promotion is a *level* condition
 *  (m ≥ tUp[tier]); normal mode requests Tier 2 and waits (single pending slot). */
function accelTransition(
  st: GaugeState,
  config: GaugeConfig,
  effects: GaugeEffect[],
  now: number,
  leaving: boolean,
): GaugeState {
  const tier = st.accelTier;
  const m = st.m;
  const maxTier = config.accel.length - 1;

  if (tier >= 1 && m <= config.tDown[tier - 1]) {
    return { ...st, accelTier: tier - 1 };
  }
  if (tier < maxTier && tier < config.tUp.length && m >= config.tUp[tier]) {
    if (st.degraded) {
      return { ...st, accelTier: tier + 1 };
    }
    // Promotion is a level condition, so skipping it while leaving costs nothing: the next
    // advance on the page the user actually lands on re-evaluates it.
    if (st.pendingTier2 == null && !snoozed(st, now) && !leaving) {
      const requestId = st.tier2ReqSeq + 1;
      // A promotion outcome escalates the tier and never nags, so its written message was
      // always staged and then dropped — a Writer call spent on nothing.
      effects.push({ type: "request_tier2", reason: "promotion", tier, pageKey: st.activePageKey as string, requestId, useWriter: false });
      return {
        ...st,
        tier2ReqSeq: requestId,
        pendingTier2: { reason: "promotion", tier, pageKey: st.activePageKey as string, requestedAt: now, requestId },
      };
    }
  }
  return st;
}

/** Re-nag scheduling via the drift-debt counter (§6). Only after an initial nag. */
function maybeRenag(st: GaugeState, config: GaugeConfig, effects: GaugeEffect[], now: number): GaugeState {
  if (st.nagN < 1) return st;
  const threshold = Math.min(config.rRenag * Math.pow(config.bBackoff, st.nagN - 1), config.rRenagMax);
  if (st.renagDebt < threshold || silenced(st, now)) return st;
  effects.push({ type: "nag", pageKey: st.activePageKey as string });
  return { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
}

/** S = 0 reached — final nag gate (§5.2b / §6). */
function sZeroGate(st: GaugeState, config: GaugeConfig, effects: GaugeEffect[], now: number): GaugeState {
  if (silenced(st, now)) return st;
  const pageKey = st.activePageKey as string;
  if (st.degraded) {
    effects.push({ type: "nag", pageKey });
    return { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
  }
  const lj = st.lastJudgment;
  const fresh = lj != null && lj.pageKey === st.activePageKey && now - lj.ts <= config.freshWindow * 1000;
  if (fresh) {
    if (lj!.flow === "drift") {
      effects.push({ type: "nag", pageKey });
      return { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
    }
    return st; // cached "ok" — verdict already overridden on arrival
  }
  const alreadySZero =
    st.pendingTier2 != null && st.pendingTier2.reason === "s_zero" && st.pendingTier2.pageKey === st.activePageKey;
  if (!alreadySZero) return requestSZero(st, effects, now);
  return st;
}

/** Open an s_zero Tier-2 confirmation for the active page. Only the FIRST confirmation of an
 *  episode pays for the Writer (see GaugeState.sZeroConfirms); the repeats a page-hopping user
 *  triggers fall back to the persona preset so the round trip they keep cancelling is half as
 *  long. Shared by both S=0 entries — the downward crossing and the already-at-zero gate — so
 *  the two cannot diverge on which requests get written messages. */
function requestSZero(st: GaugeState, effects: GaugeEffect[], now: number): GaugeState {
  const requestId = st.tier2ReqSeq + 1;
  const pageKey = st.activePageKey as string;
  const confirms = st.sZeroConfirms ?? 0; // ?? — a checkpoint written before this field existed
  effects.push({
    type: "request_tier2",
    reason: "s_zero",
    tier: st.accelTier,
    pageKey,
    requestId,
    useWriter: confirms === 0,
  });
  return {
    ...st,
    tier2ReqSeq: requestId,
    sZeroConfirms: confirms + 1,
    pendingTier2: { reason: "s_zero", tier: st.accelTier, pageKey, requestedAt: now, requestId },
  };
}

/** Integrate elapsed time into (m, s), then run the accel / renag / celebration /
 *  S=0 gates. Runs for heartbeat / nav / tier2_result (§5); not for inactive. */
function advance(
  state: GaugeState,
  now: number,
  config: GaugeConfig,
  // The user is LEAVING the page this verdict belongs to (a `neutral` settlement). Integrate it
  // — the drift that ran until they left is real and still owes S — but emit nothing that names
  // it and touch none of the nag bookkeeping. A nag decided here would be about a page that is
  // already gone from the screen: it can only be delivered on top of whatever the user just
  // opened, which is a false alarm on an innocent page. Suppressing it inside advance (rather
  // than filtering the effects afterwards) is what keeps nagN / renagDebt / pendingTier2 from
  // recording a nudge that never happened — otherwise the next page inherits a spent nag
  // counter and cannot be nudged until the re-nag debt rebuilds.
  leaving = false,
): GaugeTransition {
  const effects: GaugeEffect[] = [];
  const delta = clamp((now - state.updatedAt) / 1000, 0, config.gapCap);

  if (state.activeVerdict == null) {
    return { state: { ...state, updatedAt: now }, effects };
  }

  const d = state.activeVerdict === "DRIFT" ? 1 : -1;
  const w = state.degraded ? marginWeight(state, config) : 1.0;

  // 1) inertia
  let st: GaugeState = { ...state };
  if (delta > 0) {
    st = { ...st, m: st.m + (d - st.m) * (1 - Math.exp(-delta / config.tauM)) * w };
  }

  // 2) accel transition (uses the new m)
  st = accelTransition(st, config, effects, now, leaving);

  // 3) integrate the gauge
  const sBefore = st.s;
  if (state.activeVerdict === "DRIFT") {
    const drain = config.rDrain * config.accel[st.accelTier] * w * delta;
    st = { ...st, s: Math.max(0, st.s - drain), renagDebt: st.renagDebt + drain };
    // The debt still accrues while leaving — it is carried, not forgiven, so the page the user
    // lands on can nudge the moment its own verdict lands.
    if (!leaving) st = maybeRenag(st, config, effects, now);
  } else {
    // Recovery accelerates with return-inertia depth (issue #122 "F"): slow just
    // after a return (m>=0 -> boost 1), accelerating as m deepens negative, capped.
    const boost = Math.min(Math.exp(config.recoverGamma * Math.max(-st.m, 0)), config.recoverFMax);
    const gain = config.rRecover * ((1 - st.m) / config.kRecover) * boost * w * delta;
    st = { ...st, s: Math.min(100, st.s + gain) };
  }

  // celebration arm/fire
  if (st.s <= config.cArm) st = { ...st, celebrateArmed: true };
  if (st.celebrateArmed && st.s >= config.cCelebrate) {
    effects.push({ type: "celebrate" });
    st = { ...st, celebrateArmed: false };
  }

  // episode end (m <= 0): reset renag schedule, the Writer budget, and the refund allowance
  if (st.m <= 0) st = { ...st, nagN: 0, renagDebt: 0, sZeroConfirms: 0, nagRefunded: false };

  // S = 0 final gate. Both entries are skipped while `leaving`: the crossing the settlement
  // completes belongs to the page being left, and the already-at-zero entry below picks it up
  // on the page the user actually lands on (sBefore is 0 there, so the crossing cannot recur).
  const atZeroDrift = state.activeVerdict === "DRIFT" && st.s <= 0;
  // Honor a fresh cached Tier-2 "ok" for the active page (same window sZeroGate uses), so a
  // page Tier-2 just confirmed on-goal isn't nudged by the recovery even if Tier-0 re-flags it.
  const lj = st.lastJudgment;
  const freshOk =
    lj != null && lj.pageKey === st.activePageKey && lj.flow === "ok" && now - lj.ts <= config.freshWindow * 1000;
  const freshDrift =
    lj != null && lj.pageKey === st.activePageKey && lj.flow === "drift" && now - lj.ts <= config.freshWindow * 1000;
  if (!leaving && atZeroDrift && sBefore > 0) {
    // Normal downward crossing into 0 → confirm via Tier-2 (or nag directly if degraded).
    st = sZeroGate(st, config, effects, now);
  } else if (
    !leaving &&
    atZeroDrift &&
    st.nagN === 0 &&
    !silenced(st, now) &&
    !freshOk &&
    !effects.some((e) => e.type === "nag") && // never stack on a renag/celebrate already emitted this tick
    !(st.pendingTier2 != null && st.pendingTier2.reason === "s_zero" && st.pendingTier2.pageKey === st.activePageKey)
  ) {
    // S is ALREADY 0 and this page is drifting: the crossing edge can't recur (sBefore is
    // already 0) and maybeRenag needs nagN>=1, so without this gate the user stays stuck with
    // no nudge. The common way to get here is arriving on a fresh off-goal page after the
    // previous one drained the gauge — including the page the user opened while leaving the
    // one that spent it.
    //
    // Confirm through Tier-2 rather than nagging on Tier-0/1 alone. This gate used to nudge
    // directly, to avoid a request the user out-navigates being cancelled without advancing
    // nagN — re-asking on every page while nudging on none. That traded false alarms for
    // never missing one; the product wants the opposite trade, so the cost of a miss is
    // accepted and the unconfirmed nag is not. Two things make the churn cheaper than it was:
    // the pre-gate now cancels an out-navigated request BEFORE spending the judge call, and
    // only the episode's first confirmation pays for the Writer, halving the round trip the
    // repeats can be cancelled inside of.
    //
    // Degraded mode has no Tier-2 to ask, and a fresh cached drift verdict for this very page is
    // already a confirmation — both nudge directly, exactly as the crossing gate above does.
    //
    // `degraded` only covers "no tier has a provider AT ALL". A Tier-2 that is configured but
    // unreachable looks confirmable from here and cannot be detected without asking, so that case
    // is handled where the answer comes back: an unavailable outcome keeps the Tier-0/1 verdict
    // rather than being read as a clean bill of health (gaugeRuntime.serviceTier2).
    if (st.degraded || freshDrift) {
      effects.push({ type: "nag", pageKey: st.activePageKey as string });
      st = { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
    } else {
      st = requestSZero(st, effects, now);
    }
  }

  return { state: { ...st, updatedAt: now }, effects };
}

/** Apply a Tier 2 judgment (§6). Routes strictly by the pending request's reason;
 *  with no pending request, caches the judgment and does nothing else. */
function applyTier2(
  state: GaugeState,
  now: number,
  flow: "drift" | "ok",
  pageKey: string,
  config: GaugeConfig,
): GaugeTransition {
  const adv = advance(state, now, config);
  const effects = adv.effects;
  let st: GaugeState = { ...adv.state, lastJudgment: { pageKey, flow, ts: now } };

  const pending = st.pendingTier2;
  if (pending == null) return { state: st, effects };
  const tier = pending.tier;

  if (pending.reason === "promotion") {
    if (flow === "drift") {
      st = { ...st, accelTier: Math.min(st.accelTier + 1, config.accel.length - 1) };
    } else {
      if (tier >= 0 && tier < config.tDown.length) st = { ...st, m: Math.min(st.m, config.tDown[tier]) };
      st = { ...st, s: Math.min(100, st.s + config.bRefund) };
      if (pending.pageKey === st.activePageKey) st = { ...st, activeVerdict: "OK" };
    }
  } else {
    // reason === "s_zero"
    if (flow === "drift") {
      if (!silenced(st, now)) {
        effects.push({ type: "nag", pageKey: st.activePageKey as string });
        st = { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
      }
    } else {
      st = { ...st, s: config.rDismiss, m: Math.min(st.m, 0), accelTier: 0 };
      if (pending.pageKey === st.activePageKey) st = { ...st, activeVerdict: "OK" };
    }
  }
  return { state: { ...st, pendingTier2: null }, effects };
}

/** The reducer. Pure: no side effects, deterministic in (state, event, config). */
export function reduceGauge(
  state: GaugeState,
  event: GaugeEvent,
  config: GaugeConfig,
): GaugeTransition {
  switch (event.type) {
    case "snooze":
      return { state: { ...state, snoozedUntil: event.until }, effects: [] };
    case "inactive":
      // Contract §5: inactive does not integrate. Rebase the clock; integrate nothing.
      //
      // It decides nothing, so the quiet window cannot change what it does — but while the user
      // is away this is the ONLY tick that fires, and a `nav` landing later (observation is gated
      // on window focus, not on presence) decides under whatever was last stamped. Without this
      // the flag could hold a pre-window value for the whole night.
      return {
        state: { ...state, updatedAt: event.ts, ...(event.quiet != null ? { quiet: event.quiet } : {}) },
        effects: [],
      };
    case "heartbeat": {
      // Re-stamp the quiet window BEFORE integrating, so the tick that carries the news is
      // already governed by it rather than deciding one last nudge under the old value.
      const st = event.quiet != null ? { ...state, quiet: event.quiet } : state;
      return advance(st, event.ts, config);
    }
    case "nav": {
      // Re-stamped before integrating, like the heartbeat: a judged page can carry a verdict the
      // gauge was already holding, in which case this advance decides nags — and it can arrive
      // while the user is idle, long after the last present heartbeat.
      const st0 = event.quiet != null ? { ...state, quiet: event.quiet } : state;
      const adv = advance(st0, event.ts, config);
      let st: GaugeState = {
        ...adv.state,
        activePageKey: event.pageKey,
        activeVerdict: event.verdict,
      };
      if (event.degraded != null) st = { ...st, degraded: event.degraded };
      if (st.degraded) {
        if (event.r0 != null && event.tauOk != null) st = { ...st, activeMargin: Math.abs(event.r0 - event.tauOk) };
      } else {
        st = { ...st, activeMargin: null };
      }
      return { state: st, effects: adv.effects };
    }
    case "tier2_result":
      return applyTier2(state, event.ts, event.flow, event.pageKey, config);
    case "tier2_cancel": {
      // Release the pending slot only if it is still THIS exact request (by opaque requestId),
      // so a newer pendingTier2 (e.g. an s_zero on the page the user moved to, or a same-ms
      // re-request) is never cleared by an older job.
      const p = state.pendingTier2;
      if (p != null && p.requestId === event.requestId) {
        return { state: { ...state, pendingTier2: null }, effects: [] };
      }
      return { state, effects: [] };
    }
    case "nag_undelivered": {
      // Hand back the count for a nudge that was emitted but never surfaced. Only the count: the
      // drift debt stays where the nag left it, so this restores the RECOVERY path (the S=0 gate
      // needs nagN === 0) rather than making a re-nag due immediately.
      //
      // At most once per episode. Some pages can never host a nudge — the tab is permanently
      // sensitive, the surface keeps failing — and without the latch the gate would re-emit and
      // re-refund on every heartbeat: a nudge decided, and its chime played, once a minute
      // forever. One retry, then the silence is accepted as correct.
      if (state.nagRefunded || state.nagN <= 0) return { state, effects: [] };
      return { state: { ...state, nagN: state.nagN - 1, nagRefunded: true }, effects: [] };
    }
    case "neutral": {
      // Integrate the page they were on right up to this instant (a drift that ran until the
      // navigation still counts and still owes S), then drop the verdict. With
      // activeVerdict = null, advance() early-returns — S and m freeze — until the dwell's nav
      // event supplies the new page's verdict and integration resumes all at once. Rebasing the
      // clock via advance is what keeps the frozen interval from being back-integrated then.
      //
      // `leaving` — this settlement decides nothing ABOUT the page being left. It used to: the
      // S=0 gate and the re-nag could both fire here, naming a page the user had already
      // navigated off, so the nudge landed on whatever they had just opened. The debt is
      // carried instead, and the page they land on nudges under its own verdict.
      const adv = advance(state, event.ts, config, true);
      return {
        state: { ...adv.state, activePageKey: event.pageKey, activeVerdict: null, activeMargin: null },
        effects: adv.effects,
      };
    }
  }
}

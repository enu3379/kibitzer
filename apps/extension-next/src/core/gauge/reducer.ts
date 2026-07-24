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

/** Discrete acceleration-tier transition with hysteresis (§5). Demotion first and
 *  mutually exclusive (a step moves m one way). Promotion is a *level* condition
 *  (m ≥ tUp[tier]); normal mode requests Tier 2 and waits (single pending slot). */
function accelTransition(
  st: GaugeState,
  config: GaugeConfig,
  effects: GaugeEffect[],
  now: number,
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
    if (st.pendingTier2 == null && !snoozed(st, now)) {
      const requestId = st.tier2ReqSeq + 1;
      effects.push({ type: "request_tier2", reason: "promotion", tier, pageKey: st.activePageKey as string });
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
  if (st.renagDebt < threshold || snoozed(st, now)) return st;
  effects.push({ type: "nag", pageKey: st.activePageKey as string });
  return { ...st, lastNagTs: now, nagN: st.nagN + 1, renagDebt: 0 };
}

/** S = 0 reached — final nag gate (§5.2b / §6). */
function sZeroGate(st: GaugeState, config: GaugeConfig, effects: GaugeEffect[], now: number): GaugeState {
  if (snoozed(st, now)) return st;
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
  if (!alreadySZero) {
    const requestId = st.tier2ReqSeq + 1;
    effects.push({ type: "request_tier2", reason: "s_zero", tier: st.accelTier, pageKey });
    return {
      ...st,
      tier2ReqSeq: requestId,
      pendingTier2: { reason: "s_zero", tier: st.accelTier, pageKey, requestedAt: now, requestId },
    };
  }
  return st;
}

/** Integrate elapsed time into (m, s), then run the accel / renag / celebration /
 *  S=0 gates. Runs for heartbeat / nav / tier2_result (§5); not for inactive. */
function advance(state: GaugeState, now: number, config: GaugeConfig): GaugeTransition {
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
  st = accelTransition(st, config, effects, now);

  // 3) integrate the gauge
  const sBefore = st.s;
  if (state.activeVerdict === "DRIFT") {
    const drain = config.rDrain * config.accel[st.accelTier] * w * delta;
    st = { ...st, s: Math.max(0, st.s - drain), renagDebt: st.renagDebt + drain };
    st = maybeRenag(st, config, effects, now);
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

  // episode end (m <= 0): reset renag schedule
  if (st.m <= 0) st = { ...st, nagN: 0, renagDebt: 0 };

  // S = 0 final gate — fire only on the crossing into 0
  if (state.activeVerdict === "DRIFT" && sBefore > 0 && st.s <= 0) {
    st = sZeroGate(st, config, effects, now);
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
      if (!snoozed(st, now)) {
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
      return { state: { ...state, updatedAt: event.ts }, effects: [] };
    case "heartbeat":
      return advance(state, event.ts, config);
    case "nav": {
      const adv = advance(state, event.ts, config);
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
  }
}

// reduceGauge — the pure gauge reducer (contract §5–§6). No clock, storage,
// network, or notification access: "now" arrives only as event.ts (epoch ms).
// Same (state, event, config) always yields the same GaugeTransition.

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

/** Degraded-mode speed multiplier f(margin) = clamp((|margin|/M)^p, 0, 1). */
function marginWeight(margin: number | null, config: GaugeConfig): number {
  if (margin == null) return 0;
  return clamp(Math.pow(Math.abs(margin) / config.degradedM, config.degradedP), 0, 1);
}

function notSnoozed(state: GaugeState, ts: number): boolean {
  return state.snoozedUntil == null || ts >= state.snoozedUntil;
}

/**
 * Integrate the gauge from state.updatedAt to `ts` using the current active
 * verdict, then apply the accel transitions and gate emissions. Runs for
 * heartbeat / nav / tier2_result (contract §5); NOT for inactive.
 */
function advance(state: GaugeState, ts: number, config: GaugeConfig): GaugeTransition {
  const deltaSec = clamp((ts - state.updatedAt) / 1000, 0, config.gapCap);
  if (state.activeVerdict == null || deltaSec === 0) {
    return { state: { ...state, updatedAt: ts }, effects: [] };
  }

  const effects: GaugeEffect[] = [];
  const pageKey = state.activePageKey as string;
  const d = state.activeVerdict === "DRIFT" ? 1 : -1;
  const w = state.degraded ? marginWeight(state.activeMargin, config) : 1.0;

  // 1) inertia — direction change is slow
  const m2 = state.m + (d - state.m) * (1 - Math.exp(-deltaSec / config.tauM)) * w;

  // 2) accel transitions (hysteresis)
  let accelTier = state.accelTier;
  let pendingTier2 = state.pendingTier2;
  while (accelTier > 0 && m2 <= config.tDown[accelTier - 1]) accelTier -= 1;
  const maxTier = config.accel.length - 1;
  const crossedUp =
    accelTier < maxTier && state.m < config.tUp[accelTier] && m2 >= config.tUp[accelTier];
  if (crossedUp) {
    if (state.degraded) {
      accelTier += 1; // degraded: promote immediately, no Tier 2
    } else if (notSnoozed(state, ts)) {
      effects.push({ type: "request_tier2", reason: "promotion", tier: accelTier + 1, pageKey });
      pendingTier2 = { reason: "promotion", tier: accelTier + 1, pageKey, requestedAt: ts };
    }
  }

  // 3) integrate gauge
  let s: number;
  if (d === 1) {
    s = Math.max(0, state.s - config.rDrain * config.accel[accelTier] * w * deltaSec);
  } else {
    s = Math.min(100, state.s + config.rRecover * ((1 - m2) / config.kRecover) * w * deltaSec);
  }

  // S = 0 crossing → final gate (contract §5.2b / §6)
  if (state.s > 0 && s === 0 && notSnoozed(state, ts)) {
    const fresh =
      state.lastJudgment != null &&
      state.lastJudgment.pageKey === pageKey &&
      (ts - state.lastJudgment.ts) / 1000 <= config.freshWindow;
    if (state.degraded) {
      effects.push({ type: "nag", pageKey });
    } else if (fresh && state.lastJudgment!.flow === "drift") {
      effects.push({ type: "nag", pageKey });
    } else if (!fresh) {
      effects.push({ type: "request_tier2", reason: "s_zero", tier: accelTier, pageKey });
      pendingTier2 = { reason: "s_zero", tier: accelTier, pageKey, requestedAt: ts };
    }
    // fresh && flow === "ok": cached dismissal — stay silent (contract §5.2b).
  }

  // renag debt (only after the first nag of the episode; contract §6)
  let renagDebt = state.renagDebt;
  if (d === 1 && state.nagN > 0) {
    renagDebt += config.rDrain * config.accel[accelTier] * w * deltaSec;
    const threshold = Math.min(
      config.rRenag * Math.pow(config.bBackoff, state.nagN - 1),
      config.rRenagMax,
    );
    if (renagDebt >= threshold && notSnoozed(state, ts)) {
      effects.push({ type: "nag", pageKey });
      renagDebt = 0;
    }
  }

  // celebration arm/fire (contract §6)
  let celebrateArmed = state.celebrateArmed;
  if (s <= config.cArm) celebrateArmed = true;
  if (celebrateArmed && s >= config.cCelebrate) {
    effects.push({ type: "celebrate" });
    celebrateArmed = false;
  }

  // episode reset when inertia returns to recovery (m <= 0)
  let nagN = state.nagN;
  if (m2 <= 0) {
    nagN = 0;
    renagDebt = 0;
  }

  return {
    state: {
      ...state,
      s,
      m: m2,
      accelTier,
      updatedAt: ts,
      pendingTier2,
      renagDebt,
      celebrateArmed,
      nagN,
    },
    effects,
  };
}

/** Tier 2 verdict arrives (contract §5.2 / §6). Advances first, then resolves. */
function applyTier2(state: GaugeState, ts: number, flow: "drift" | "ok", pageKey: string, config: GaugeConfig): GaugeTransition {
  const adv = advance(state, ts, config);
  let st = adv.state;
  const effects: GaugeEffect[] = [...adv.effects];
  const lastJudgment = { pageKey, flow, ts };
  const reason = st.pendingTier2?.reason ?? (st.s === 0 ? "s_zero" : "promotion");
  const isActive = st.activePageKey === pageKey;

  if (flow === "drift") {
    if (reason === "s_zero") {
      effects.push({ type: "nag", pageKey });
      st = { ...st, nagN: st.nagN + 1, renagDebt: 0, lastNagTs: ts };
    } else {
      const maxTier = config.accel.length - 1;
      st = { ...st, accelTier: Math.min(maxTier, st.accelTier + 1) };
    }
  } else {
    // flow === "ok": reject / dismiss with refund + effective-verdict override.
    if (reason === "s_zero") {
      st = { ...st, s: config.rDismiss, m: Math.min(st.m, 0), accelTier: 0 };
    } else {
      const downIdx = Math.max(0, st.accelTier - 1);
      const floor = config.tDown.length > 0 ? config.tDown[downIdx] : 0;
      st = { ...st, s: Math.min(100, st.s + config.bRefund), m: Math.min(st.m, floor) };
    }
    if (isActive) st = { ...st, activeVerdict: "OK" }; // override until page change
  }

  return { state: { ...st, lastJudgment, pendingTier2: null }, effects };
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
      // Contract §5: inactive does not integrate. Freeze the clock and pause
      // integration until the next nav re-establishes the active page.
      return { state: { ...state, updatedAt: event.ts, activeVerdict: null }, effects: [] };
    case "heartbeat":
      return advance(state, event.ts, config);
    case "nav": {
      const adv = advance(state, event.ts, config);
      const degraded = event.degraded ?? adv.state.degraded;
      const activeMargin =
        event.r0 != null && event.tauOk != null ? Math.abs(event.r0 - event.tauOk) : null;
      return {
        state: {
          ...adv.state,
          activePageKey: event.pageKey,
          activeVerdict: event.verdict,
          degraded,
          activeMargin,
        },
        effects: adv.effects,
      };
    }
    case "tier2_result":
      return applyTier2(state, event.ts, event.flow, event.pageKey, config);
  }
}

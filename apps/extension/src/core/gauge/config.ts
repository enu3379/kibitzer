// Default gauge configuration — contract §8 placeholder knobs. NONE of these are
// calibrated; they are provisional until the D4 Replay CLI tunes them. Fixtures
// pin their own `config`, so these defaults are only used at runtime (shadow).

import type { GaugeConfig } from "./types.ts";

// Sublinear session-time anchor (contract §8). Fallback T_budget = 15 min.
const B_REF_SECONDS = 15 * 60;
const T_REF_SECONDS = 2 * 60 * 60;
const BUDGET_ALPHA = 0.585;
const MIN_TOTAL_SECONDS = 5 * 60;
const B_MAX_SECONDS = 30 * 60;
const FALLBACK_T_BUDGET_SECONDS = 15 * 60;

/** T_budget = clamp(B_ref * (goal / T_ref)^alpha, min_total, B_max). */
export function tBudgetSeconds(goalMinutes: number | null): number {
  if (goalMinutes == null) return FALLBACK_T_BUDGET_SECONDS;
  const raw = B_REF_SECONDS * Math.pow((goalMinutes * 60) / T_REF_SECONDS, BUDGET_ALPHA);
  return Math.min(B_MAX_SECONDS, Math.max(MIN_TOTAL_SECONDS, Math.round(raw)));
}

export function defaultGaugeConfig(goalMinutes: number | null = null): GaugeConfig {
  const tBudget = tBudgetSeconds(goalMinutes);
  return {
    rDrain: 100 / tBudget,
    rRecover: 100 / tBudget,
    accel: [1.0, 1.5, 2.5],
    tauM: 300,
    tUp: [0.5, 0.8],
    tDown: [0.2, 0.5],
    kRecover: 2.45,
    recoverGamma: 3.0,
    recoverFMax: 6.0,
    gapCap: 90,
    rRenag: 40,
    bBackoff: 2.0,
    rRenagMax: 320,
    cArm: 20,
    cCelebrate: 80,
    rDismiss: 30,
    bRefund: 10,
    freshWindow: 600,
    degradedP: 3,
    degradedM: 0.25,
  };
}

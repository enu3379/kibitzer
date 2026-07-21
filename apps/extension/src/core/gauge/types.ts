// Gauge v0 core types — the reference implementation of docs/gauge/contract.md.
// Field names are camelCase and match the shared fixture JSON byte-for-byte
// (fixtures/gauge/*.json). The Python track maps these to snake_case; TypeScript
// consumes the JSON shape directly.

export type Verdict = "OK" | "DRIFT";
export type Flow = "drift" | "ok";
export type Tier2Reason = "promotion" | "s_zero";

export interface Judgment {
  pageKey: string;
  flow: Flow;
  ts: number;
}

export interface PendingTier2 {
  reason: Tier2Reason;
  tier: number;
  pageKey: string;
  requestedAt: number;
}

/** GaugeState — contract §2. All time fields are epoch milliseconds. */
export interface GaugeState {
  s: number; // immersion gauge [0,100]
  m: number; // inertia [-1,1]
  accelTier: number; // {0,1,2}
  updatedAt: number; // last integration time (ms)
  activePageKey: string | null;
  activeVerdict: Verdict | null; // effective verdict (Tier2 override applied)
  degraded: boolean;
  activeMargin: number | null; // |r0 - tauOk| for degraded mode
  pendingTier2: PendingTier2 | null;
  lastJudgment: Judgment | null;
  nagN: number; // nag ordinal this episode (reset when m<=0)
  renagDebt: number;
  lastNagTs: number | null;
  celebrateArmed: boolean;
  snoozedUntil: number | null;
}

/** GaugeConfig — contract §8 placeholder knobs. Seconds / per-second units. */
export interface GaugeConfig {
  rDrain: number;
  rRecover: number;
  accel: number[]; // A[tier]
  tauM: number; // inertia time constant (s)
  tUp: number[]; // promotion thresholds (tier i -> i+1)
  tDown: number[]; // demotion thresholds (tier i+1 -> i)
  kRecover: number; // recovery denominator in (1-m)/k
  gapCap: number; // heartbeat gap cap (s)
  rRenag: number;
  bBackoff: number;
  rRenagMax: number;
  cArm: number;
  cCelebrate: number;
  rDismiss: number;
  bRefund: number;
  freshWindow: number; // Tier2 cache freshness (s)
  degradedP: number; // margin exponent p
  degradedM: number; // margin scale M
}

/** GaugeEvent — contract §3 (discriminated union on `type`). ts is epoch ms. */
export type GaugeEvent =
  | { type: "nav"; pageKey: string; verdict: Verdict; r0?: number; tauOk?: number; degraded?: boolean; ts: number }
  | { type: "heartbeat"; ts: number }
  | { type: "inactive"; ts: number }
  | { type: "tier2_result"; flow: Flow; pageKey: string; ts: number }
  | { type: "snooze"; until: number; ts: number };

/** GaugeEffect — contract §4 (intents; shadow mode records but does not act). */
export type GaugeEffect =
  | { type: "request_tier2"; reason: Tier2Reason; tier: number; pageKey: string }
  | { type: "nag"; pageKey: string }
  | { type: "celebrate" };

export interface GaugeTransition {
  state: GaugeState;
  effects: GaugeEffect[];
}

/** Initial GaugeState (contract §2 init column). Fixtures override a subset. */
export function initGaugeState(): GaugeState {
  return {
    s: 100,
    m: 0,
    accelTier: 0,
    updatedAt: 0,
    activePageKey: null,
    activeVerdict: null,
    degraded: false,
    activeMargin: null,
    pendingTier2: null,
    lastJudgment: null,
    nagN: 0,
    renagDebt: 0,
    lastNagTs: null,
    celebrateArmed: false,
    snoozedUntil: null,
  };
}

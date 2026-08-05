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
  // Opaque, strictly-increasing id (from GaugeState.tier2ReqSeq) that uniquely identifies
  // THIS request instance. requestedAt (an epoch-ms timestamp) can collide for two requests
  // created in the same millisecond; requestId cannot, so an old durable job can't apply to
  // or cancel a newer same-page/reason request.
  requestId: number;
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
  tier2ReqSeq: number; // monotonic source of PendingTier2.requestId (never reused within a state's life)
  lastJudgment: Judgment | null;
  nagN: number; // nag ordinal this episode (reset when m<=0)
  renagDebt: number;
  lastNagTs: number | null;
  // How many s_zero Tier-2 confirmations this episode has ASKED FOR (not how many landed).
  // Only the first one pays for the Writer; the rest fall back to the persona preset. While
  // the user page-hops at S=0 every request resolves after they have moved on and is
  // cancelled, so nagN never advances and the gate re-asks on the next page — spending a
  // two-call round trip each time and nudging on none of them. Dropping the Writer from the
  // repeats halves that round trip, which narrows the window a hop can cancel in. Reset with
  // nagN when the episode ends (m<=0).
  sZeroConfirms: number;
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
  kRecover: number; // recovery denominator K in (1-m)/K
  recoverGamma: number; // exponential gain on return-inertia depth (issue #122 "F")
  recoverFMax: number; // cap on the recovery boost e^(gamma*max(-m,0))
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
  // Clear a pending Tier-2 request that resolved stale (page/goal moved on) without applying
  // a verdict — releases the pendingTier2 slot so promotion can request again, with no
  // side effect on the now-active page. Only clears if the slot is still this exact request
  // (matched by requestId). Wiring-only; the shared fixtures never emit it.
  | { type: "tier2_cancel"; requestId: number; ts: number }
  // A new page is being observed but its verdict isn't known yet (the dwell hasn't produced a
  // judgement). Integrate the page they were on up to this instant, then stop: hold the gauge
  // steady (no drain / no recover) until the dwell's nav event supplies the fresh verdict, so a
  // page the user has left can't keep moving S on a stale verdict. Wiring-only; the shared
  // parity fixtures never emit it.
  | { type: "neutral"; pageKey: string; ts: number }
  | { type: "snooze"; until: number; ts: number };

/** GaugeEffect — contract §4 (intents; shadow mode records but does not act). */
export type GaugeEffect =
  // requestId ties this effect to the exact pendingTier2 slot it opened. Two request_tier2
  // effects can be emitted in ONE reduce (promotion then s_zero, which overwrites the slot);
  // each must carry its OWN id so the wiring doesn't tag both with the final slot's id.
  // useWriter: may this request pay for the second (message-writing) LLM call once the judge
  // says notify? False for every promotion request — a promotion outcome escalates the accel
  // tier and never nags, so the written message was always discarded — and for repeat s_zero
  // confirmations within one episode (see GaugeState.sZeroConfirms). The nag then carries the
  // persona preset instead.
  | { type: "request_tier2"; reason: Tier2Reason; tier: number; pageKey: string; requestId: number; useWriter: boolean }
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
    tier2ReqSeq: 0,
    lastJudgment: null,
    nagN: 0,
    renagDebt: 0,
    lastNagTs: null,
    sZeroConfirms: 0,
    celebrateArmed: false,
    snoozedUntil: null,
  };
}

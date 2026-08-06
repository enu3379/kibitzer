// Surfaces LLM provider health so a mid-session failure (expired key, 429, 403, timeout)
// isn't silent. tier12 records ok/error on each call; the popup and toolbar mark report
// per tier. The tiers route to independent provider+model pairs (providers.ts), so health
// is keyed per tier — a single global slot let a Tier-1 success overwrite a live Tier-2
// failure (#205). Within one tier, last-write-wins is the meaning of the slot: "that
// tier's most recent call".

import { ProviderHttpError, ProviderResponseError } from "../providers/errors.ts"
import type { ProviderId, TierName, TierRoute } from "./providers.ts"

// v2 keys: the v1 single-slot record (kibitzer:provider-health:v1) is transient display
// state — it is simply orphaned, not migrated.
const KEY = {
  tier1: "kibitzer:provider-health:tier1:v2",
  tier2: "kibitzer:provider-health:tier2:v2",
} as const

/** A record this old no longer describes the provider's present. Enforced here on the
 *  read side (getProviderHealth) so the popup and the toolbar mark cannot disagree;
 *  formatAgo (providerHealthView.ts) uses the same constant for its expiry cut. */
export const HEALTH_TTL_MS = 24 * 60 * 60_000

/** Which Tier-2 call failed. The session-recap writer records as "writer" too — one
 *  bucket; Tier 1 has no stage distinction in the UI. */
export type Tier2Stage = "judge" | "writer"

export interface TierHealth {
  ok: boolean
  kind: string
  message: string
  ts: number
  /** Present on tier2 error records only. */
  stage?: Tier2Stage
}

export interface ProviderHealthSnapshot {
  tier1: TierHealth | null
  tier2: TierHealth | null
}

/** Classify a provider failure into a short kind + Korean note. Never includes the
 *  provider body or credentials (the error types already strip those). */
export function classifyProviderError(error: unknown): { kind: string; message: string } {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return { kind: "auth", message: "API 키 인증 실패 (키 확인 필요)" }
    if (error.status === 429) return { kind: "rate_limited", message: "요청 한도 초과 (429)" }
    if (error.status >= 500) return { kind: "server", message: `서버 오류 (${error.status})` }
    return { kind: "http", message: `HTTP ${error.status}` }
  }
  if (error instanceof ProviderResponseError) {
    if (error.stage === "output_exhausted") return { kind: "output", message: "응답 예산 초과 (출력 토큰 부족)" }
    return { kind: "response", message: `응답 파싱 실패 (${error.stage})` }
  }
  if (error instanceof Error && error.name === "AbortError") return { kind: "timeout", message: "응답 시간 초과" }
  return { kind: "error", message: String(error).slice(0, 80) }
}

export async function recordProviderOk(tier: TierName): Promise<void> {
  await chrome.storage.local.set({ [KEY[tier]]: { ok: true, kind: "", message: "", ts: Date.now() } })
}

// The overloads make the stage mandatory exactly where it is meaningful: every tier2
// error names the call that failed; tier1 records never carry one.
export async function recordProviderError(tier: "tier1", error: unknown): Promise<void>
export async function recordProviderError(tier: "tier2", error: unknown, stage: Tier2Stage): Promise<void>
export async function recordProviderError(tier: TierName, error: unknown, stage?: Tier2Stage): Promise<void> {
  const { kind, message } = classifyProviderError(error)
  const record: TierHealth = { ok: false, kind, message, ts: Date.now(), ...(stage ? { stage } : {}) }
  await chrome.storage.local.set({ [KEY[tier]]: record })
}

function liveRecord(value: unknown, now: number): TierHealth | null {
  if (!value || typeof (value as TierHealth).ok !== "boolean") return null
  const record = value as TierHealth
  return now - record.ts >= HEALTH_TTL_MS ? null : record
}

/** Per-tier health with the 24h expiry already applied — an expired record comes back
 *  null, so no consumer can show it. */
export async function getProviderHealth(now: number = Date.now()): Promise<ProviderHealthSnapshot> {
  const stored = await chrome.storage.local.get([KEY.tier1, KEY.tier2])
  return { tier1: liveRecord(stored[KEY.tier1], now), tier2: liveRecord(stored[KEY.tier2], now) }
}

/** Forget the named tiers' records — called when provider settings change, so the
 *  toolbar's alert mark doesn't keep accusing a config the user just fixed. Tier-scoped:
 *  fixing Tier 1's key must not erase a still-valid Tier-2 error display. */
export async function clearProviderHealth(tiers: readonly TierName[]): Promise<void> {
  if (tiers.length === 0) return
  await chrome.storage.local.remove(tiers.map((tier) => KEY[tier]))
}

/** Which tiers a provider-settings mutation invalidates health for: a key change on
 *  provider X touches every tier routed to X (before or after — mutations can also
 *  reroute via the automatic-route logic), and any tier whose effective route changed.
 *  Pass provider=null for a pure route save. */
export function tiersAffectedByProviderChange(
  provider: ProviderId | null,
  before: { tier1: TierRoute; tier2: TierRoute },
  after: { tier1: TierRoute; tier2: TierRoute },
): TierName[] {
  return (["tier1", "tier2"] as const).filter((tier) => {
    const b = before[tier]
    const a = after[tier]
    if (provider != null && (b.provider === provider || a.provider === provider)) return true
    return b.provider !== a.provider || b.model !== a.model
  })
}

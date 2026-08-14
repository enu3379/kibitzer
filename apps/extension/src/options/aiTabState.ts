// Pure state rules for the AI settings tab.
//
// The tab has three independent inputs — the user's preference, whether both tiers are
// configured, and whether real calls are failing — and they used to be flattened into one
// alert stack, where a single string mixed all three ("AI 판정이 꺼져 있어요. …설정하거나
// …비활성화해 주세요."). That string could contradict the toggle next to it and could ask
// for an action the (disabled) toggle could not perform.
//
// They are now separated:
//   aiStatus()      — what the user is looking at, one of three states, rendered as one line
//   aiStatusTone()  — how loud that line is (runtime failures colour it, they don't reword it)
//   tierGap()       — what a tier is still missing, rendered next to that tier's controls
//
// Preference is intent, not effect: preferring AI with an unfinished setup is `pending`
// (it turns itself on once the setup completes), so the preference toggle never has to be
// disabled and can never strand the user.

import type { ProviderId, TierName } from "../lib/providers.ts"

export type RouteDrafts = Record<TierName, { provider: ProviderId; model: string }>
export type AccountKeyLists = Partial<Record<ProviderId, readonly unknown[]>>

const TIERS: readonly TierName[] = ["tier1", "tier2"]

/** What a tier still needs before it can run. Null once it can. */
export type TierGap = "model" | "key" | "both"

export function tierGap(
  tier: TierName,
  routes: RouteDrafts,
  accounts: AccountKeyLists,
): TierGap | null {
  const route = routes[tier]
  const noModel = route.model.trim().length === 0
  const noKey = (accounts[route.provider]?.length ?? 0) === 0
  return noModel && noKey ? "both" : noModel ? "model" : noKey ? "key" : null
}

export function isAiConfigComplete(routes: RouteDrafts, accounts: AccountKeyLists): boolean {
  return TIERS.every((tier) => tierGap(tier, routes, accounts) === null)
}

export function providerIsRouted(provider: ProviderId, routes: RouteDrafts): boolean {
  return TIERS.some((tier) => routes[tier].provider === provider)
}

/** Which tiers point at this provider — names the tiers a destructive provider action
 *  would break, so the refusal can say which ones instead of just "사용 중". */
export function routedTiers(provider: ProviderId, routes: RouteDrafts): TierName[] {
  return TIERS.filter((tier) => routes[tier].provider === provider)
}

/** The one state the status line reports. `active` is also what the runtime calls
 *  running — it mirrors tier12's own gate (preference ON, both tiers resolving to a
 *  keyed provider), so the line cannot claim a mode the worker is not in.
 *  - `off`     the user turned AI judging off
 *  - `pending` the user wants AI judging, but a tier is still unconfigured — it starts by
 *              itself the moment the last gap is filled
 *  - `active`  running (a runtime failure does not change the state, only its tone) */
export type AiStatus = "off" | "pending" | "active"

export function aiStatus(
  preferred: boolean,
  routes: RouteDrafts,
  accounts: AccountKeyLists,
): AiStatus {
  if (!preferred) return "off"
  return isAiConfigComplete(routes, accounts) ? "active" : "pending"
}

/** How loudly to paint the status line. `off` is amber, not neutral: running without AI
 *  is supported but degraded, and the line is the only place that still says so.
 *
 *  `alertLevel` must be derived from the very lines the alert stack is about to draw, not
 *  from the raw records: an expired record still counts for providerAlertLevel but no
 *  longer produces a fact, which would paint the line red over an empty stack. */
export type AiStatusTone = "ok" | "warn" | "err"

export function aiStatusTone(
  status: AiStatus,
  alertLevel: "red" | "amber" | null,
): AiStatusTone {
  if (status !== "active") return "warn"
  return alertLevel === "red" ? "err" : alertLevel === "amber" ? "warn" : "ok"
}

export interface StatusCopy {
  text: string
  /** Second line; null when the headline says everything. */
  sub: string | null
}

export const STATUS_COPY: Record<AiStatus, StatusCopy> = {
  // Runtime failures are deliberately absent here: which tier failed, why, and what it
  // costs are the alert stack's job, and repeating them in the headline was the old
  // duplication. The tone carries the severity.
  active: { text: "AI 판정 켜짐", sub: null },
  pending: { text: "AI 판정 준비 중", sub: "아래 Tier 1·2 설정을 마치면 켜져요" },
  off: {
    text: "AI 판정 꺼짐",
    sub: "로컬 판정으로 동작 중입니다. AI 판정을 비활성화하면 판정 품질이 낮아지고 훈수 메시지가 단순해져요.",
  },
}

/** `pending` has two shapes and they need different instructions. The status line reads
 *  the SAVED routes while the tier rows read the draft, so a user can finish every gap
 *  below and still be pending until 저장 — pointing them "아래" at rows that now look
 *  complete is a dead end. Filling a key gap re-routes through the worker on its own, so
 *  that case really does need nothing but the setup. */
export function pendingSub(draftComplete: boolean): string {
  return draftComplete ? "아래 설정을 저장하면 켜져요" : STATUS_COPY.pending.sub ?? ""
}

export function tierGapCopy(gap: TierGap, providerLabel: string): string {
  if (gap === "model") return "모델을 선택해 주세요"
  if (gap === "key") return `${providerLabel}에 API 키를 연결해 주세요`
  return `모델 선택과 ${providerLabel} API 키 연결이 필요해요`
}

/** Why a provider control refused. Two different guards, so two different sentences:
 *  disconnecting is blocked whenever the provider is routed, deleting a key only when it
 *  is that provider's last one. Both name the routed tiers and both offer the same two
 *  ways out. Particle-free after the tier list ("에"/"에서") so "Tier 1"/"Tier 2" read
 *  correctly either way. */
export type ProviderLockKind = "last-key" | "disconnect"

export function providerLockCopy(kind: ProviderLockKind, tierLabels: readonly string[]): string {
  const tiers = tierLabels.join(" · ")
  const escape = "다른 제공자로 바꾸거나 AI 판정을 꺼주세요."
  return kind === "last-key"
    ? `${tiers}에 쓰이는 마지막 키예요. ${escape}`
    : `이 제공자를 ${tiers}에서 쓰고 있어요. ${escape}`
}

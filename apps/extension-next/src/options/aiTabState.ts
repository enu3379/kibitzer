// Pure state rules for the AI settings tab. AI judging is one complete mode: both
// Tier 1 and Tier 2 need a non-empty model and a key on the routed provider. An
// incomplete setup cannot be saved or activated; users may still explicitly turn a
// complete setup off and keep the saved routes/keys for later.

import type { ProviderId, TierName } from "../lib/providers.ts"

export type RouteDrafts = Record<TierName, { provider: ProviderId; model: string }>
export type AccountKeyLists = Partial<Record<ProviderId, readonly unknown[]>>

const TIERS: readonly TierName[] = ["tier1", "tier2"]

export const INCOMPLETE_COPY =
  "AI 판정이 꺼져 있어요. Tier 1·2의 모델과 API 키를 모두 설정하거나 AI 판정을 비활성화해 주세요."
export const DISABLED_COPY =
  "AI 판정을 비활성화하면 판정 품질이 낮아지고 훈수 메시지가 단순해져요."

export function incompleteTiers(routes: RouteDrafts, accounts: AccountKeyLists): TierName[] {
  return TIERS.filter((tier) => {
    const route = routes[tier]
    return route.model.trim().length === 0 || (accounts[route.provider]?.length ?? 0) === 0
  })
}

export function isAiConfigComplete(routes: RouteDrafts, accounts: AccountKeyLists): boolean {
  return incompleteTiers(routes, accounts).length === 0
}

export function providerIsRouted(provider: ProviderId, routes: RouteDrafts): boolean {
  return TIERS.some((tier) => routes[tier].provider === provider)
}

/** An ON preference must always be switchable OFF, even after its config breaks. */
export function canToggleAiPreference(
  preferred: boolean,
  configComplete: boolean,
  routeTestFailed: boolean,
): boolean {
  return preferred || (configComplete && !routeTestFailed)
}

/** What the runtime/UI should call active: preference ON plus a complete two-tier setup. */
export function effectiveAiEnabled(
  preferred: boolean,
  routes: RouteDrafts,
  accounts: AccountKeyLists,
): boolean {
  return preferred && isAiConfigComplete(routes, accounts)
}

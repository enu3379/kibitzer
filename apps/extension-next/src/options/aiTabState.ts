// Single-signal model for the AI 판정 tab. The tab shows exactly one signal at a time:
// zero keys anywhere → the muted local-only status line (AI 미사용 is an advertised
// normal mode, not a fault), a route bypassing available keys → the amber banner
// (반쪽 구성), both routed providers keyed → nothing (완전 구성). The same classification
// also drives a one-time soft confirm on the 저장 button when a save would commit a half
// config the user only just created. DOM-free so every decision tests in plain Node.

import type { ProviderId, TierName } from "../lib/providers.ts"

/** Both the saved routes and the on-screen draft fit this shape. */
export type RouteProviders = Record<TierName, { provider: ProviderId }>
/** The options page's public accounts view — only key counts matter here. */
export type AccountKeyLists = Partial<Record<ProviderId, readonly unknown[]>>

export type AiConfigState = "unused" | "half" | "full"

export type SaveClickDecision = { action: "save" } | { action: "confirm"; tier: TierName }

export const LOCAL_ONLY_STATUS = "AI 미사용 — 로컬 판정과 준비된 훈수 문구만으로 동작 중이에요"

/** Copy for the soft confirm, keyed by which tier the save would leave keyless. */
export const CONFIRM_COPY: Record<TierName, string> = {
  tier1:
    "Tier 1이 키 없는 프로바이더를 가리켜요 — 멀쩡한 페이지에서 훈수를 받을 수도 있어요. 한 번 더 누르면 그대로 저장해요.",
  tier2:
    "Tier 2가 키 없는 프로바이더를 가리켜요 — 내용 확인 없이 준비된 문구로만 훈수하게 돼요. 한 번 더 누르면 그대로 저장해요.",
}

const TIERS: readonly TierName[] = ["tier1", "tier2"]

function keyCount(accounts: AccountKeyLists, provider: ProviderId): number {
  return accounts[provider]?.length ?? 0
}

/** Tiers whose route points at a provider with no registered key. */
export function keylessTiers(routes: RouteProviders, accounts: AccountKeyLists): TierName[] {
  return TIERS.filter((tier) => keyCount(accounts, routes[tier].provider) === 0)
}

export function classifyAiConfig(routes: RouteProviders, accounts: AccountKeyLists): AiConfigState {
  const total = Object.values(accounts).reduce((sum, keys) => sum + (keys?.length ?? 0), 0)
  if (total === 0) return "unused"
  // Keys exist but a route bypasses them → half. That includes the rare case where BOTH
  // routes point at keyless providers while a key sits unused elsewhere: still a
  // misrouting worth flagging, unlike the deliberate zero-key local-only mode.
  return keylessTiers(routes, accounts).length > 0 ? "half" : "full"
}

/** Identity of a half state: which tiers are keyless and where they point. Models are
 *  deliberately excluded — re-picking a model on the keyless tier is caught by the
 *  touched flag, not by a signature change. Null when the config isn't half. */
export function halfSignature(routes: RouteProviders, accounts: AccountKeyLists): string | null {
  if (classifyAiConfig(routes, accounts) !== "half") return null
  return keylessTiers(routes, accounts)
    .map((tier) => `${tier}:${routes[tier].provider}`)
    .join("|")
}

/** Account changes can void the acknowledged half state but never grant acknowledgment:
 *  a half state the user saved stays acknowledged only while it still describes the
 *  saved config. A key removal that CREATES half-ness must not self-acknowledge — the
 *  next save has to go through the confirm. */
export function reconcileHalfSignature(
  prevSig: string | null,
  savedRoutes: RouteProviders,
  accounts: AccountKeyLists,
): string | null {
  return halfSignature(savedRoutes, accounts) === prevSig ? prevSig : null
}

/** Should this save interpose the soft confirm, and with which tier's copy? Confirms
 *  only a NEW half config: one whose signature differs from the last acknowledged save,
 *  or whose keyless tier the user touched in this draft. A standing half being re-saved
 *  through an edit on the keyed tier passes straight through — the standing amber
 *  banner already covers it. */
export function confirmTierForSave(
  lastSavedHalfSig: string | null,
  draftRoutes: RouteProviders,
  accounts: AccountKeyLists,
  touched: Record<TierName, boolean>,
): TierName | null {
  const sig = halfSignature(draftRoutes, accounts)
  if (sig === null) return null // 미사용 or 완전 구성 — never interpose
  const tiers = keylessTiers(draftRoutes, accounts)
  if (sig === lastSavedHalfSig && !tiers.some((tier) => touched[tier])) return null
  // Both keyless (keys parked elsewhere): tier2's copy — losing the nag writer is the
  // bigger loss than tier1's extra false positives.
  return tiers.includes("tier2") ? "tier2" : "tier1"
}

/** The 저장 button's two-step brain: with a confirm already pending the click always
 *  saves; otherwise a qualifying half config turns the click into the confirm step. */
export function decideSaveClick(
  pendingConfirmTier: TierName | null,
  lastSavedHalfSig: string | null,
  draftRoutes: RouteProviders,
  accounts: AccountKeyLists,
  touched: Record<TierName, boolean>,
): SaveClickDecision {
  if (pendingConfirmTier !== null) return { action: "save" }
  const tier = confirmTierForSave(lastSavedHalfSig, draftRoutes, accounts, touched)
  return tier ? { action: "confirm", tier } : { action: "save" }
}

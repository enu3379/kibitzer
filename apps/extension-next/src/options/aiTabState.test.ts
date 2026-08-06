import assert from "node:assert/strict"
import test from "node:test"

import type { ProviderId } from "../lib/providers.ts"

import {
  CONFIRM_COPY,
  LOCAL_ONLY_STATUS,
  classifyAiConfig,
  confirmTierForSave,
  decideSaveClick,
  halfSignature,
  keylessTiers,
  reconcileHalfSignature,
  type AccountKeyLists,
  type RouteProviders,
} from "./aiTabState.ts"

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `key-${i}`)

const routes = (tier1: ProviderId, tier2: ProviderId): RouteProviders => ({
  tier1: { provider: tier1 },
  tier2: { provider: tier2 },
})

const untouched = { tier1: false, tier2: false }

// --- three-state classification --------------------------------------------------

test("zero keys across all providers is 미사용, wherever the routes point", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: [] }
  assert.equal(classifyAiConfig(routes("ollama", "ollama"), accounts), "unused")
  assert.equal(classifyAiConfig(routes("gemini", "ollama"), accounts), "unused")
})

test("one keyless-routed tier next to a keyed one is 반쪽 구성 — either tier", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(classifyAiConfig(routes("ollama", "gemini"), accounts), "half") // tier1 keyless
  assert.equal(classifyAiConfig(routes("gemini", "ollama"), accounts), "half") // tier2 keyless
})

test("both routed providers keyed is 완전 구성", () => {
  const accounts: AccountKeyLists = { ollama: keys(2), gemini: keys(1) }
  assert.equal(classifyAiConfig(routes("gemini", "ollama"), accounts), "full")
  assert.equal(classifyAiConfig(routes("ollama", "ollama"), accounts), "full")
})

test("keys parked on an unrouted provider with both routes keyless is still half", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(classifyAiConfig(routes("ollama", "ollama"), accounts), "half")
})

test("keylessTiers lists exactly the tiers routed past the keys", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.deepEqual(keylessTiers(routes("ollama", "gemini"), accounts), ["tier1"])
  assert.deepEqual(keylessTiers(routes("gemini", "ollama"), accounts), ["tier2"])
  assert.deepEqual(keylessTiers(routes("ollama", "ollama"), accounts), ["tier1", "tier2"])
  assert.deepEqual(keylessTiers(routes("gemini", "gemini"), accounts), [])
})

// --- banner visibility (single-signal rule) --------------------------------------

test("banner rule: zero keys classifies as 미사용, so no half state exists to banner", () => {
  // The DOM renders the banner only for "half" — an all-keyless local user must never
  // see it (the status line owns that state), even though both routes are keyless.
  const accounts: AccountKeyLists = { ollama: [] }
  assert.equal(classifyAiConfig(routes("ollama", "ollama"), accounts), "unused")
  assert.equal(halfSignature(routes("ollama", "ollama"), accounts), null)
})

// --- half signature --------------------------------------------------------------

test("halfSignature names the keyless tier and its provider, null otherwise", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(halfSignature(routes("gemini", "ollama"), accounts), "tier2:ollama")
  assert.equal(halfSignature(routes("ollama", "gemini"), accounts), "tier1:ollama")
  assert.equal(halfSignature(routes("ollama", "ollama"), accounts), "tier1:ollama|tier2:ollama")
  assert.equal(halfSignature(routes("gemini", "gemini"), accounts), null) // full
  assert.equal(halfSignature(routes("ollama", "ollama"), { ollama: [] }), null) // unused
})

test("reconcileHalfSignature keeps an acknowledged half only while it still holds", () => {
  const half = routes("gemini", "ollama")
  // Standing half survives unrelated account changes (second key on the keyed tier).
  assert.equal(
    reconcileHalfSignature("tier2:ollama", half, { ollama: [], gemini: keys(2) }),
    "tier2:ollama",
  )
  // A key added to the keyless provider cures the half — acknowledgment is void.
  assert.equal(
    reconcileHalfSignature("tier2:ollama", half, { ollama: keys(1), gemini: keys(1) }),
    null,
  )
})

test("reconcileHalfSignature never manufactures an acknowledgment", () => {
  // The saved config IS half in every case below — a reconcile that answered with the
  // current signature would acknowledge a half the user never saved, silencing the
  // key-removal confirm. It may only ever keep prevSig or void it.
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(reconcileHalfSignature(null, routes("gemini", "ollama"), accounts), null)
  assert.equal(reconcileHalfSignature(null, routes("ollama", "ollama"), accounts), null)
  // A stale acknowledgment of a DIFFERENT half voids — it must not update to the new one.
  assert.equal(reconcileHalfSignature("tier1:ollama", routes("gemini", "ollama"), accounts), null)
})

// --- confirm trigger matrix ------------------------------------------------------

test("confirm: a half config newly created by draft edits", () => {
  // Last save was full (sig null); the draft moved tier2 onto keyless ollama.
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  const tier = confirmTierForSave(null, routes("gemini", "ollama"), accounts, {
    tier1: false,
    tier2: true,
  })
  assert.equal(tier, "tier2")
})

test("confirm: a half config newly created by key removal, with no draft edit", () => {
  // Last save was full; the tier2 provider's only key was then deleted. The signature
  // was captured while full (null), so the untouched draft still reads as new half.
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(confirmTierForSave(null, routes("gemini", "ollama"), accounts, untouched), "tier2")
})

test("no confirm: standing half re-saved through a keyed-tier-only tweak", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  const tier = confirmTierForSave("tier2:ollama", routes("gemini", "ollama"), accounts, {
    tier1: true, // model change on the keyed tier
    tier2: false,
  })
  assert.equal(tier, null)
})

test("confirm: standing half whose keyless tier the draft touched", () => {
  // Same signature as the last save (same tier, same provider — e.g. a model swap),
  // but the user reworked the keyless tier: re-confirm.
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  const tier = confirmTierForSave("tier2:ollama", routes("gemini", "ollama"), accounts, {
    tier1: false,
    tier2: true,
  })
  assert.equal(tier, "tier2")
})

test("never confirm with zero keys anywhere — 미사용 is a normal mode", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: [] }
  const touchedBoth = { tier1: true, tier2: true }
  assert.equal(confirmTierForSave(null, routes("ollama", "ollama"), accounts, touchedBoth), null)
})

test("never confirm a fully keyed config", () => {
  const accounts: AccountKeyLists = { ollama: keys(1), gemini: keys(1) }
  const touchedBoth = { tier1: true, tier2: true }
  assert.equal(confirmTierForSave(null, routes("gemini", "ollama"), accounts, touchedBoth), null)
})

test("confirm copy tier follows the keyless tier, tier2 winning when both are keyless", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  assert.equal(confirmTierForSave(null, routes("ollama", "gemini"), accounts, untouched), "tier1")
  assert.equal(confirmTierForSave(null, routes("gemini", "ollama"), accounts, untouched), "tier2")
  assert.equal(confirmTierForSave(null, routes("ollama", "ollama"), accounts, untouched), "tier2")
})

// --- two-step save button --------------------------------------------------------

test("first qualifying click asks, second click passes", () => {
  const accounts: AccountKeyLists = { ollama: [], gemini: keys(1) }
  const draft = routes("gemini", "ollama")
  const first = decideSaveClick(null, null, draft, accounts, untouched)
  assert.deepEqual(first, { action: "confirm", tier: "tier2" })
  // The pending tier is the only state the second click needs — it always saves.
  const second = decideSaveClick("tier2", null, draft, accounts, untouched)
  assert.deepEqual(second, { action: "save" })
})

// --- verbatim copy ---------------------------------------------------------------

test("status line and confirm copy are pinned verbatim — a rewording fails here", () => {
  assert.equal(LOCAL_ONLY_STATUS, "AI 미사용 — 로컬 판정과 준비된 훈수 문구만으로 동작 중이에요")
  assert.equal(
    CONFIRM_COPY.tier1,
    "Tier 1이 키 없는 프로바이더를 가리켜요 — 멀쩡한 페이지에서 훈수를 받을 수도 있어요. 한 번 더 누르면 그대로 저장해요.",
  )
  assert.equal(
    CONFIRM_COPY.tier2,
    "Tier 2가 키 없는 프로바이더를 가리켜요 — 내용 확인 없이 준비된 문구로만 훈수하게 돼요. 한 번 더 누르면 그대로 저장해요.",
  )
})

test("a click with nothing to confirm saves immediately", () => {
  const accounts: AccountKeyLists = { ollama: keys(1) }
  assert.deepEqual(decideSaveClick(null, null, routes("ollama", "ollama"), accounts, untouched), {
    action: "save",
  })
})

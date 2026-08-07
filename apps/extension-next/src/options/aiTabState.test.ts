import assert from "node:assert/strict"
import test from "node:test"

import type { ProviderId } from "../lib/providers.ts"
import {
  DISABLED_COPY,
  INCOMPLETE_COPY,
  canToggleAiPreference,
  effectiveAiEnabled,
  incompleteTiers,
  isAiConfigComplete,
  providerIsRouted,
  type AccountKeyLists,
  type RouteDrafts,
} from "./aiTabState.ts"

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `key-${i}`)
const routes = (
  tier1: ProviderId,
  tier2: ProviderId,
  models: readonly [string, string] = ["fast", "precise"],
): RouteDrafts => ({
  tier1: { provider: tier1, model: models[0] },
  tier2: { provider: tier2, model: models[1] },
})

test("both tiers require a model and a key on their routed provider", () => {
  const accounts: AccountKeyLists = { ollama: keys(1), gemini: [] }
  assert.deepEqual(incompleteTiers(routes("ollama", "gemini"), accounts), ["tier2"])
  assert.deepEqual(incompleteTiers(routes("gemini", "ollama"), accounts), ["tier1"])
  assert.deepEqual(incompleteTiers(routes("ollama", "ollama", ["", "precise"]), accounts), ["tier1"])
})

test("a complete two-tier setup is saveable even when both tiers share one keyed provider", () => {
  const accounts: AccountKeyLists = { ollama: keys(1) }
  assert.equal(isAiConfigComplete(routes("ollama", "ollama"), accounts), true)
  assert.equal(isAiConfigComplete(routes("ollama", "gemini"), accounts), false)
})

test("effective activation also honors the explicit user preference", () => {
  const accounts: AccountKeyLists = { ollama: keys(1) }
  const complete = routes("ollama", "ollama")
  assert.equal(effectiveAiEnabled(true, complete, accounts), true)
  assert.equal(effectiveAiEnabled(false, complete, accounts), false)
  assert.equal(effectiveAiEnabled(true, routes("ollama", "gemini"), accounts), false)
})

test("destructive provider controls can tell whether a key is used by either tier", () => {
  const split = routes("ollama", "gemini")
  assert.equal(providerIsRouted("ollama", split), true)
  assert.equal(providerIsRouted("gemini", split), true)
  assert.equal(providerIsRouted("openai", split), false)
})

test("an incomplete ON preference keeps the escape hatch to local-only mode", () => {
  assert.equal(canToggleAiPreference(true, false, false), true)
  assert.equal(canToggleAiPreference(false, false, false), false)
  assert.equal(canToggleAiPreference(false, true, true), false)
  assert.equal(canToggleAiPreference(false, true, false), true)
})

test("warning copy is pinned", () => {
  assert.equal(
    INCOMPLETE_COPY,
    "AI 판정이 꺼져 있어요. Tier 1·2의 모델과 API 키를 모두 설정하거나 AI 판정을 비활성화해 주세요.",
  )
  assert.equal(
    DISABLED_COPY,
    "AI 판정을 비활성화하면 판정 품질이 낮아지고 훈수 메시지가 단순해져요.",
  )
})

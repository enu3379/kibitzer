import assert from "node:assert/strict"
import test from "node:test"

import type { ProviderId } from "../lib/providers.ts"
import {
  DISABLED_COPY,
  INCOMPLETE_COPY,
  effectiveAiEnabled,
  incompleteTiers,
  isAiConfigComplete,
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

test("warning copy is pinned", () => {
  assert.equal(
    INCOMPLETE_COPY,
    "AI 판정이 꺼져 있어요. Tier 1·2를 모두 설정하면 더 정확한 판정과 자연스러운 훈수를 사용할 수 있어요.",
  )
  assert.equal(
    DISABLED_COPY,
    "AI 판정을 비활성화하면 판정 품질이 낮아지고 훈수 메시지가 단순해져요.",
  )
})

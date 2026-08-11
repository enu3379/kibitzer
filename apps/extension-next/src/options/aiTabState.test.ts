import assert from "node:assert/strict"
import test from "node:test"

import type { ProviderId } from "../lib/providers.ts"
import {
  STATUS_COPY,
  aiStatus,
  aiStatusTone,
  isAiConfigComplete,
  providerIsRouted,
  providerLockCopy,
  routedTiers,
  tierGap,
  tierGapCopy,
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

test("a complete two-tier setup is saveable even when both tiers share one keyed provider", () => {
  const accounts: AccountKeyLists = { ollama: keys(1) }
  assert.equal(isAiConfigComplete(routes("ollama", "ollama"), accounts), true)
  assert.equal(isAiConfigComplete(routes("ollama", "gemini"), accounts), false)
})

test("a gap names what is missing, not just which tier — model and key are told apart", () => {
  const accounts: AccountKeyLists = { ollama: keys(1), gemini: [] }
  assert.equal(tierGap("tier1", routes("ollama", "ollama"), accounts), null)
  assert.equal(tierGap("tier1", routes("ollama", "ollama", ["", "precise"]), accounts), "model")
  assert.equal(tierGap("tier2", routes("ollama", "gemini"), accounts), "key")
  assert.equal(tierGap("tier2", routes("ollama", "gemini", ["fast", ""]), accounts), "both")
})

test("gap copy names the provider only where the user has to go connect one", () => {
  assert.equal(tierGapCopy("model", "Google Gemini"), "모델을 선택해 주세요")
  assert.equal(tierGapCopy("key", "Google Gemini"), "Google Gemini에 API 키를 연결해 주세요")
  assert.equal(tierGapCopy("both", "Google Gemini"), "모델 선택과 Google Gemini API 키 연결이 필요해요")
})

test("destructive provider controls can name the tiers they would break", () => {
  const split = routes("ollama", "gemini")
  assert.equal(providerIsRouted("ollama", split), true)
  assert.equal(providerIsRouted("openai", split), false)
  assert.deepEqual(routedTiers("ollama", split), ["tier1"])
  assert.deepEqual(routedTiers("openai", split), [])
  assert.deepEqual(routedTiers("ollama", routes("ollama", "ollama")), ["tier1", "tier2"])
})

test("status is one of three — an unfinished setup the user wants is pending, not off", () => {
  const accounts: AccountKeyLists = { ollama: keys(1) }
  const complete = routes("ollama", "ollama")
  const incomplete = routes("ollama", "gemini")
  assert.equal(aiStatus(true, complete, accounts), "active")
  assert.equal(aiStatus(true, incomplete, accounts), "pending")
  // Turning it off is a decision about intent — the config behind it is irrelevant.
  assert.equal(aiStatus(false, complete, accounts), "off")
  assert.equal(aiStatus(false, incomplete, accounts), "off")
})

test("runtime failures colour the status line without rewording it", () => {
  assert.equal(STATUS_COPY.active.sub, null, "the active headline stands alone")
  assert.equal(aiStatusTone("active", null), "ok")
  assert.equal(aiStatusTone("active", "amber"), "warn")
  assert.equal(aiStatusTone("active", "red"), "err")
  // Not running AI is supported but degraded: never neutral, whatever the config says.
  assert.equal(aiStatusTone("off", null), "warn")
  assert.equal(aiStatusTone("pending", null), "warn")
})

test("status copy states the mode without asking for an action the toggle cannot take", () => {
  assert.equal(STATUS_COPY.active.text, "AI 판정 켜짐")
  assert.equal(STATUS_COPY.pending.text, "AI 판정 준비 중")
  assert.equal(STATUS_COPY.pending.sub, "아래 설정을 마치면 자동으로 켜져요")
  assert.equal(STATUS_COPY.off.text, "AI 판정 꺼짐")
  assert.equal(
    STATUS_COPY.off.sub,
    "로컬 판정으로 동작 중입니다. AI 판정을 비활성화하면 판정 품질이 낮아지고 훈수 메시지가 단순해져요.",
  )
  for (const copy of Object.values(STATUS_COPY)) {
    assert.ok(!copy.text.includes("비활성화"), `${copy.text}: the headline states, it does not command`)
  }
})

test("a refused provider control names the routed tiers and both ways out", () => {
  assert.equal(
    providerLockCopy("last-key", ["Tier 1", "Tier 2"]),
    "Tier 1 · Tier 2에 쓰이는 마지막 키예요. 다른 제공자로 바꾸거나 AI 판정을 꺼주세요.",
  )
  assert.equal(
    providerLockCopy("disconnect", ["Tier 2"]),
    "이 제공자를 Tier 2에서 쓰고 있어요. 다른 제공자로 바꾸거나 AI 판정을 꺼주세요.",
  )
})

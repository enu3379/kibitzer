// Tier 1 / Tier 2 via **Ollama Cloud** (https://ollama.com) — the project default
// (configs/experiment-models.example.yaml, docs/ml-providers.md, planning-notes D3).
// Provider/prompts/payloads/parsing were ported in Phase 4; this is the wiring. The
// provider already rotates a key **pool** on 401/403/429, so a whole set of keys is
// passed through (matching the server's api_key_pool_envs).

import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import { buildTier1Payload, buildTier2ReviewPayload } from "../providers/payloads.ts"
import type { JudgeVerdict } from "../providers/types.ts"

const OLLAMA_KEY = "kibitzer:ollama:v2"

const DEFAULTS = {
  apiUrl: "https://ollama.com/api/chat",
  tier1Model: "nemotron-3-super", // Ollama Cloud fast classifier (Tier 1)
  tier2Model: "minimax-m3", // Ollama Cloud judge + Korean writer (Tier 2)
} as const

export interface OllamaConfig {
  apiUrl: string
  apiKeys: string[] // rotated automatically by the provider on 401/403/429
  tier1Model: string
  tier2Model: string
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
}

/** Full config, defaults merged. Empty `apiKeys` means Cloud is off (Tier-0 only). */
export async function getOllamaConfig(): Promise<OllamaConfig> {
  const stored = await chrome.storage.local.get(OLLAMA_KEY)
  const value = (stored[OLLAMA_KEY] ?? {}) as Partial<OllamaConfig>
  return {
    apiUrl: str(value.apiUrl) || DEFAULTS.apiUrl,
    apiKeys: keyList(value.apiKeys),
    tier1Model: str(value.tier1Model) || DEFAULTS.tier1Model,
    tier2Model: str(value.tier2Model) || DEFAULTS.tier2Model,
  }
}

export async function setOllamaConfig(input: Partial<OllamaConfig>): Promise<OllamaConfig> {
  const merged: OllamaConfig = {
    apiUrl: str(input.apiUrl) || DEFAULTS.apiUrl,
    apiKeys: keyList(input.apiKeys),
    tier1Model: str(input.tier1Model) || DEFAULTS.tier1Model,
    tier2Model: str(input.tier2Model) || DEFAULTS.tier2Model,
  }
  await chrome.storage.local.set({ [OLLAMA_KEY]: merged })
  tier1Provider = tier2Provider = null
  fingerprint = null
  return merged
}

export async function ollamaEnabled(): Promise<boolean> {
  return (await getOllamaConfig()).apiKeys.length > 0
}

let tier1Provider: OllamaChatJudgeProvider | null = null
let tier2Provider: OllamaChatJudgeProvider | null = null
let fingerprint: string | null = null

async function providers(): Promise<{ tier1: OllamaChatJudgeProvider; tier2: OllamaChatJudgeProvider } | null> {
  const config = await getOllamaConfig()
  if (config.apiKeys.length === 0) {
    tier1Provider = tier2Provider = null
    fingerprint = null
    return null
  }
  const fp = JSON.stringify(config)
  if (!tier1Provider || !tier2Provider || fingerprint !== fp) {
    const base = { apiUrl: config.apiUrl, apiKeys: config.apiKeys, timeoutMs: 30_000, maxOutputTokens: 512, writerMaxOutputTokens: 1024 }
    tier1Provider = new OllamaChatJudgeProvider({ ...base, model: config.tier1Model })
    tier2Provider = new OllamaChatJudgeProvider({ ...base, model: config.tier2Model })
    fingerprint = fp
  }
  return { tier1: tier1Provider, tier2: tier2Provider }
}

/** Let Tier 1 rescue a Tier-0 DRIFT (may return OK) or confirm it. Failure keeps DRIFT. */
export async function tier1Rescue(goalText: string, title: string, urlHost: string): Promise<JudgeVerdict> {
  const p = await providers()
  if (!p) return "DRIFT"
  try {
    const result = await p.tier1.classifyTier1(buildTier1Payload({ rawText: goalText }, { title, urlHost }, []))
    return result.verdict
  } catch (error) {
    console.warn("[kbz] tier1 error (keeping DRIFT):", error)
    return "DRIFT"
  }
}

export interface Tier2Outcome {
  flow: "drift" | "ok"
  message: string | null
}

export interface OllamaTestResult {
  ok: boolean
  tier1?: string
  tier2?: string
  error?: string
}

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; stage?: unknown; status?: unknown }
    const parts = [record.message, record.stage, record.status].filter((v) => v != null).map(String)
    if (parts.length) return parts.join(" · ")
  }
  return String(error)
}

/** One real round-trip to Ollama Cloud with the given config (both models). Reports
 *  success or a readable error, without saving — for the popup's connection test. */
export async function testOllama(input: Partial<OllamaConfig>): Promise<OllamaTestResult> {
  const apiUrl = str(input.apiUrl) || DEFAULTS.apiUrl
  const apiKeys = keyList(input.apiKeys)
  const tier1Model = str(input.tier1Model) || DEFAULTS.tier1Model
  const tier2Model = str(input.tier2Model) || DEFAULTS.tier2Model
  if (apiKeys.length === 0) return { ok: false, error: "API 키를 먼저 입력하세요" }
  const base = { apiUrl, apiKeys, timeoutMs: 30_000, maxOutputTokens: 256, writerMaxOutputTokens: 256 }
  try {
    const t1 = new OllamaChatJudgeProvider({ ...base, model: tier1Model })
    const r1 = await t1.classifyTier1(
      buildTier1Payload({ rawText: "테스트" }, { title: "예시 페이지", urlHost: "example.com" }, []),
    )
    const t2 = new OllamaChatJudgeProvider({ ...base, model: tier2Model })
    await t2.confirmTier2(
      buildTier2ReviewPayload(
        { rawText: "테스트" },
        { title: "예시 페이지", urlHost: "example.com", verdict: "DRIFT", tierReached: 0, tier0Score: 0.3 },
        [],
        null,
        [],
        null,
      ),
    )
    return { ok: true, tier1: `${tier1Model} ✓ (${r1.verdict})`, tier2: `${tier2Model} ✓` }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

/** Confirm a drift via Tier 2. No keys / failure → "ok" (false-positive-first). */
export async function tier2Confirm(
  goalText: string,
  page: { title: string; urlHost: string; score: number },
): Promise<Tier2Outcome> {
  const p = await providers()
  if (!p) return { flow: "ok", message: null }
  try {
    const payload = buildTier2ReviewPayload(
      { rawText: goalText },
      { title: page.title, urlHost: page.urlHost, verdict: "DRIFT", tierReached: 0, tier0Score: page.score },
      [],
      null,
      [],
      null,
    )
    const result = await p.tier2.confirmTier2(payload)
    return { flow: result.confirmDrift ? "drift" : "ok", message: result.message }
  } catch (error) {
    console.warn("[kbz] tier2 error (fail-open to ok, no nag):", error)
    return { flow: "ok", message: null }
  }
}

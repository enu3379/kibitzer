// Tier 1 / Tier 2 via **Ollama Cloud** (https://ollama.com) — the project default
// (configs/experiment-models.example.yaml, docs/ml-providers.md, planning-notes D3).
// The provider/prompts/payloads/parsing were ported in Phase 4; this is the wiring:
// a Cloud API key + models, a cached provider per tier, Tier 1 rescue, Tier 2 confirm.

import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import { buildTier1Payload, buildTier2ReviewPayload } from "../providers/payloads.ts"
import type { JudgeVerdict } from "../providers/types.ts"

const OLLAMA_KEY = "kibitzer:ollama:v2"

const DEFAULTS = {
  apiUrl: "https://ollama.com/api/chat",
  apiKey: "",
  tier1Model: "nemotron-3-super", // Ollama Cloud fast classifier (Tier 1)
  tier2Model: "minimax-m3", // Ollama Cloud judge + Korean writer (Tier 2)
} as const

export interface OllamaConfig {
  apiUrl: string
  apiKey: string
  tier1Model: string
  tier2Model: string
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Full config, defaults merged in. `apiKey === ""` means Cloud is off (Tier-0 only). */
export async function getOllamaConfig(): Promise<OllamaConfig> {
  const stored = await chrome.storage.local.get(OLLAMA_KEY)
  const value = (stored[OLLAMA_KEY] ?? {}) as Partial<OllamaConfig>
  return {
    apiUrl: str(value.apiUrl) || DEFAULTS.apiUrl,
    apiKey: str(value.apiKey),
    tier1Model: str(value.tier1Model) || DEFAULTS.tier1Model,
    tier2Model: str(value.tier2Model) || DEFAULTS.tier2Model,
  }
}

export async function setOllamaConfig(input: Partial<OllamaConfig>): Promise<OllamaConfig> {
  const merged: OllamaConfig = {
    apiUrl: str(input.apiUrl) || DEFAULTS.apiUrl,
    apiKey: str(input.apiKey),
    tier1Model: str(input.tier1Model) || DEFAULTS.tier1Model,
    tier2Model: str(input.tier2Model) || DEFAULTS.tier2Model,
  }
  await chrome.storage.local.set({ [OLLAMA_KEY]: merged })
  tier1Provider = null
  tier2Provider = null
  fingerprint = null
  return merged
}

export async function ollamaEnabled(): Promise<boolean> {
  return (await getOllamaConfig()).apiKey !== ""
}

let tier1Provider: OllamaChatJudgeProvider | null = null
let tier2Provider: OllamaChatJudgeProvider | null = null
let fingerprint: string | null = null

async function providers(): Promise<{ tier1: OllamaChatJudgeProvider; tier2: OllamaChatJudgeProvider } | null> {
  const config = await getOllamaConfig()
  if (!config.apiKey) {
    tier1Provider = tier2Provider = null
    fingerprint = null
    return null
  }
  const fp = JSON.stringify(config)
  if (!tier1Provider || !tier2Provider || fingerprint !== fp) {
    const base = { apiUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: 30_000, maxOutputTokens: 512, writerMaxOutputTokens: 1024 }
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
  } catch {
    return "DRIFT"
  }
}

export interface Tier2Outcome {
  flow: "drift" | "ok"
  message: string | null
}

/** Confirm a drift via Tier 2. No key / failure → "ok" (false-positive-first). */
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
  } catch {
    return { flow: "ok", message: null }
  }
}

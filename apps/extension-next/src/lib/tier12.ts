// Tier 1 / Tier 2 via a local Ollama chat model. The provider, prompts, payloads
// and response parsing were ported in Phase 4 — this is the wiring: config storage,
// a cached provider, a Tier 1 rescue call, and a Tier 2 confirm mapped onto the
// gauge's flow(drift|ok) schema.

import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import { buildTier1Payload, buildTier2ReviewPayload } from "../providers/payloads.ts"
import type { JudgeVerdict } from "../providers/types.ts"

const OLLAMA_KEY = "kibitzer:ollama:v1"
const DEFAULT_URL = "http://127.0.0.1:11434/api/chat"

export interface OllamaConfig {
  apiUrl: string
  model: string
}

export async function getOllamaConfig(): Promise<OllamaConfig | null> {
  const stored = await chrome.storage.local.get(OLLAMA_KEY)
  const value = stored[OLLAMA_KEY] as Partial<OllamaConfig> | undefined
  if (!value || typeof value.model !== "string" || !value.model.trim()) return null
  const apiUrl = typeof value.apiUrl === "string" && value.apiUrl.trim() ? value.apiUrl.trim() : DEFAULT_URL
  return { apiUrl, model: value.model.trim() }
}

export async function setOllamaConfig(apiUrl: string, model: string): Promise<OllamaConfig | null> {
  const trimmedModel = model.trim()
  if (!trimmedModel) {
    await chrome.storage.local.remove(OLLAMA_KEY)
    provider = null
    fingerprint = null
    return null
  }
  const config: OllamaConfig = { apiUrl: apiUrl.trim() || DEFAULT_URL, model: trimmedModel }
  await chrome.storage.local.set({ [OLLAMA_KEY]: config })
  return config
}

export async function ollamaEnabled(): Promise<boolean> {
  return (await getOllamaConfig()) !== null
}

let provider: OllamaChatJudgeProvider | null = null
let fingerprint: string | null = null

async function getProvider(): Promise<OllamaChatJudgeProvider | null> {
  const config = await getOllamaConfig()
  if (!config) {
    provider = null
    fingerprint = null
    return null
  }
  const fp = JSON.stringify(config)
  if (!provider || fingerprint !== fp) {
    provider = new OllamaChatJudgeProvider({
      apiUrl: config.apiUrl,
      model: config.model,
      timeoutMs: 30_000,
      maxOutputTokens: 512,
      writerMaxOutputTokens: 1024,
    })
    fingerprint = fp
  }
  return provider
}

/** Let Tier 1 rescue a Tier-0 DRIFT (may return OK) or confirm it. Failure keeps DRIFT. */
export async function tier1Rescue(goalText: string, title: string, urlHost: string): Promise<JudgeVerdict> {
  const p = await getProvider()
  if (!p) return "DRIFT"
  try {
    const result = await p.classifyTier1(buildTier1Payload({ rawText: goalText }, { title, urlHost }, []))
    return result.verdict
  } catch {
    return "DRIFT"
  }
}

export interface Tier2Outcome {
  flow: "drift" | "ok"
  message: string | null
}

/** Confirm a drift via Tier 2. No provider / failure → "ok" (false-positive-first). */
export async function tier2Confirm(
  goalText: string,
  page: { title: string; urlHost: string; score: number },
): Promise<Tier2Outcome> {
  const p = await getProvider()
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
    const result = await p.confirmTier2(payload)
    return { flow: result.confirmDrift ? "drift" : "ok", message: result.message }
  } catch {
    return { flow: "ok", message: null }
  }
}

// Tier 1 / Tier 2 via **Ollama Cloud** (https://ollama.com) — the project default
// (configs/experiment-models.example.yaml, docs/ml-providers.md, planning-notes D3).
// Provider/prompts/payloads/parsing were ported in Phase 4; this is the wiring. The
// provider already rotates a key **pool** on 401/403/429, so a whole set of keys is
// passed through (matching the server's api_key_pool_envs).

import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import {
  buildTier1Payload,
  buildTier2MessagePayload,
  buildTier2ReviewPayload,
  type RecentTitle,
} from "../providers/payloads.ts"
import type { JudgeVerdict } from "../providers/types.ts"
import {
  activePersona,
  clampSentences,
  composeWriterPrompt,
  DEFAULT_MAX_SENTENCES,
  pickFallback,
} from "./personas.ts"
import { klog } from "./klog.ts"

/** History-derived context for the Tier-2 writer (built by gaugeRuntime from the nag /
 *  visit logs). `nagCount` is the 1-based ordinal of the nag about to be produced.
 *  `excerpt` is the current page's body text (null when it couldn't be extracted). */
export interface Tier2Context {
  nagCount: number
  naggingContext: Record<string, unknown>
  recentTitles: readonly RecentTitle[]
  excerpt: string | null
}

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
    // These Cloud models reason before answering; a small budget exhausts before the
    // JSON verdict (output_exhausted). Match the server's Judge budget.
    const base = { apiUrl: config.apiUrl, apiKeys: config.apiKeys, timeoutMs: 60_000, maxOutputTokens: 4096, writerMaxOutputTokens: 2048 }
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
    klog(`tier1 error (keeping DRIFT): ${String(error)}`)
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
  const base = { apiUrl, apiKeys, timeoutMs: 60_000, maxOutputTokens: 4096, writerMaxOutputTokens: 2048 }
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

/** Confirm a drift via Tier 2 — judge (notify/defer) then, if notify, the Writer in the
 *  selected persona's voice. No keys / judge failure → "ok" (false-positive-first). A
 *  Writer failure still nags, using the persona's offline fallback template.
 *
 *  `nagCount` is the 1-based ordinal of the nag about to be produced (drives the persona's
 *  "오늘 N번째" flavor and the fallback template index). */
export async function tier2Confirm(
  goalText: string,
  page: { title: string; urlHost: string; score: number },
  ctx: Tier2Context = { nagCount: 1, naggingContext: {}, recentTitles: [], excerpt: null },
): Promise<Tier2Outcome> {
  const p = await providers()
  if (!p) return { flow: "ok", message: null }
  const observation = {
    title: page.title,
    urlHost: page.urlHost,
    verdict: "DRIFT" as const,
    tierReached: 0,
    tier0Score: page.score,
  }
  let decision
  try {
    const reviewPayload = buildTier2ReviewPayload(
      { rawText: goalText },
      observation,
      ctx.recentTitles,
      ctx.excerpt, // page body text → page_excerpt (content evidence for the judge)
      [],
      null,
    )
    decision = await p.tier2.decideTier2(reviewPayload)
  } catch (error) {
    klog(`tier2 judge error (fail-open to ok, no nag): ${String(error)}`)
    return { flow: "ok", message: null }
  }
  klog(`tier2 judge: ${decision.decision} (${decision.reasonCode}, basis=${decision.basis})`)
  if (decision.decision !== "notify") return { flow: "ok", message: null }
  // Notify confirmed → write the nag in the selected persona's voice.
  const persona = await activePersona()
  const maxSentences = persona.maxSentences ?? DEFAULT_MAX_SENTENCES
  const messagePayload = buildTier2MessagePayload(
    { rawText: goalText },
    observation,
    decision,
    null,
    ctx.naggingContext,
  )
  try {
    const message = await p.tier2.writeTier2Message(messagePayload, composeWriterPrompt(persona))
    return { flow: "drift", message: clampSentences(message, maxSentences) }
  } catch (error) {
    klog(`tier2 writer error (persona fallback template): ${String(error)}`)
    const message = pickFallback(persona, ctx.nagCount, {
      goal: goalText,
      title: page.title || page.urlHost || "현재 페이지",
      host: page.urlHost || "현재 페이지",
    })
    return { flow: "drift", message: message ? clampSentences(message, maxSentences) : message }
  }
}

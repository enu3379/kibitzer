// OpenAI chat.completions adapter — one wire format covers Gemini (compat layer),
// OpenRouter, DeepSeek, OpenAI itself, Kimi, and (if ever unified) Ollama's
// /v1 endpoint. Same judge surface and key-pool rotation as ollamaChat.ts.
//
// Deliberately NOT sent (YAGNI, verified 2026-07-28):
// - response_format: judgeParsing.loadJsonObject already extracts the JSON object from
//   surrounding prose, and json_object support varies across compat providers.
// - provider-specific thinking toggles (DeepSeek v4 thinks by default, Kimi uses a
//   non-standard field): a thinking Tier-1 call is slower but correct — revisit only
//   if latency data says so.

import {
  parseJudgeContent,
  postJsonRotating,
  rotated,
} from "./chatTransport.ts"
import { ProviderResponseError } from "./errors.ts"
import { withResponseDebug } from "./responseDebug.ts"
import {
  parseTier1Json,
  parseTier2DecisionJson,
  parseTier2Json,
  truncateCodePoints,
} from "./judgeParsing.ts"
import {
  TIER1_OLLAMA_SYSTEM_PROMPT,
  TIER2_JUDGE_SYSTEM_PROMPT,
  TIER2_LEGACY_SYSTEM_PROMPT,
} from "./prompts.ts"
import type {
  JudgeProvider,
  Tier1Result,
  Tier2Decision,
  Tier2Result,
} from "./types.ts"

const GOAL_ENRICHMENT_MAX_TOKENS = 2048

interface ChatMessage {
  role: "system" | "user"
  content: string
}

export interface OpenAIChatJudgeOptions {
  chatUrl: string
  model: string
  apiKeys: readonly string[]
  timeoutMs?: number
  maxOutputTokens?: number
  writerMaxOutputTokens?: number
  /** gpt-5.x rejects `max_tokens`; every other compat provider still expects it. */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /** gpt-5.x rejects non-default temperature — omit instead of sending 0. */
  omitTemperature?: boolean
  fetch?: typeof fetch
  onUsage?: (tokensIn: number, tokensOut: number) => void
}

export class OpenAIChatJudgeProvider implements JudgeProvider {
  private readonly chatUrl: string
  private readonly model: string
  private readonly apiKeys: readonly string[]
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly writerMaxOutputTokens: number
  private readonly maxTokensField: "max_tokens" | "max_completion_tokens"
  private readonly omitTemperature: boolean
  private readonly fetchFn: typeof fetch
  private readonly onUsage?: (tokensIn: number, tokensOut: number) => void
  private rotation = 0

  constructor(options: OpenAIChatJudgeOptions) {
    if (!options.chatUrl) throw new Error("chatUrl is required")
    if (!options.model) throw new Error("model is required")
    this.chatUrl = options.chatUrl
    this.model = options.model
    this.apiKeys = options.apiKeys
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxOutputTokens = options.maxOutputTokens ?? 512
    this.writerMaxOutputTokens = options.writerMaxOutputTokens ?? 1024
    this.maxTokensField = options.maxTokensField ?? "max_tokens"
    this.omitTemperature = options.omitTemperature ?? false
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.onUsage = options.onUsage
  }

  async classifyTier1(payload: Record<string, unknown>): Promise<Tier1Result> {
    return this.judgeCall(
      [
        { role: "system", content: TIER1_OLLAMA_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      this.maxOutputTokens,
      parseTier1Json,
    )
  }

  async completeGoalEnrichment(prompt: string, timeoutMs: number): Promise<string> {
    const response = await this.postChat([{ role: "user", content: prompt }], {
      timeoutMs,
      maxTokens: GOAL_ENRICHMENT_MAX_TOKENS,
    })
    return withResponseDebug(response, "openai goal enrichment", () => chatContent(response))
  }

  async confirmTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_LEGACY_SYSTEM_PROMPT,
  ): Promise<Tier2Result> {
    return this.judgeCall(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      this.maxOutputTokens,
      parseTier2Json,
    )
  }

  async decideTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_JUDGE_SYSTEM_PROMPT,
  ): Promise<Tier2Decision> {
    return this.judgeCall(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      this.maxOutputTokens,
      parseTier2DecisionJson,
    )
  }

  async writeTier2Message(
    payload: Record<string, unknown>,
    systemPrompt: string,
    opts: { temperature?: number } = {},
  ): Promise<string> {
    const response = await this.postChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      { maxTokens: this.writerMaxOutputTokens, temperature: opts.temperature },
    )
    return withResponseDebug(response, "openai tier2 writer", () => {
      const content = chatContent(response).trim()
      if (chatExhausted(response, this.writerMaxOutputTokens)) {
        throw new ProviderResponseError(
          "output_exhausted",
          "tier2 writer response exhausted output budget",
        )
      }
      if (!content) {
        throw new ProviderResponseError("writer_empty", "tier2 writer response was empty")
      }
      return truncateCodePoints(content, 320)
    })
  }

  private async judgeCall<T>(
    messages: ChatMessage[],
    maxTokens: number,
    parser: (content: string) => T,
  ): Promise<T> {
    const response = await this.postChat(messages, { maxTokens })
    return withResponseDebug(response, "openai judge", () => (
      parseJudgeContent(
        chatContent(response),
        chatExhausted(response, maxTokens),
        parser,
      )
    ))
  }

  private async postChat(
    messages: ChatMessage[],
    options: { timeoutMs?: number; maxTokens: number; temperature?: number },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      [this.maxTokensField]: options.maxTokens,
    }
    if (!this.omitTemperature) body.temperature = options.temperature ?? 0
    const response = await postJsonRotating({
      url: this.chatUrl,
      body,
      debugContext: "openai transport",
      keys: rotated(this.apiKeys, this.rotation++),
      headersFor: (key) => ({ authorization: `Bearer ${key}` }),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      fetchFn: this.fetchFn,
    })
    this.reportUsage(response)
    return response
  }

  private reportUsage(response: Record<string, unknown>): void {
    if (!this.onUsage) return
    const usage = (response.usage ?? {}) as Record<string, unknown>
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
    this.onUsage(num(usage.prompt_tokens), num(usage.completion_tokens))
  }
}

function firstChoice(response: Record<string, unknown>): Record<string, unknown> {
  const choices = response.choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    return choices[0] as Record<string, unknown>
  }
  throw new ProviderResponseError("envelope", "chat response had no choices")
}

export function chatContent(response: Record<string, unknown>): string {
  const message = firstChoice(response).message
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content
    if (typeof content === "string" && content) return content
  }
  throw new ProviderResponseError("envelope", "chat response did not include content")
}

export function chatExhausted(
  response: Record<string, unknown>,
  maxOutputTokens: number,
): boolean {
  if (firstChoice(response).finish_reason === "length") return true
  const usage = (response.usage ?? {}) as Record<string, unknown>
  const completion = usage.completion_tokens
  return typeof completion === "number" && completion >= maxOutputTokens
}

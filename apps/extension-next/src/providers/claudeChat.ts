// Anthropic Messages API adapter — the one provider that does not speak the OpenAI
// chat.completions format. Same judge surface and key-pool rotation as the other
// adapters. Temperature is never sent: current Claude models (Sonnet 5 / Opus 4.7+)
// reject non-default sampling parameters, and the judges' determinism comes from the
// prompts, not temperature 0.

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

const ANTHROPIC_VERSION = "2023-06-01"
const GOAL_ENRICHMENT_MAX_TOKENS = 2048

export interface ClaudeChatJudgeOptions {
  chatUrl: string
  model: string
  apiKeys: readonly string[]
  timeoutMs?: number
  maxOutputTokens?: number
  writerMaxOutputTokens?: number
  fetch?: typeof fetch
  onUsage?: (tokensIn: number, tokensOut: number) => void
}

export class ClaudeChatJudgeProvider implements JudgeProvider {
  private readonly chatUrl: string
  private readonly model: string
  private readonly apiKeys: readonly string[]
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly writerMaxOutputTokens: number
  private readonly fetchFn: typeof fetch
  private readonly onUsage?: (tokensIn: number, tokensOut: number) => void
  private rotation = 0

  constructor(options: ClaudeChatJudgeOptions) {
    if (!options.chatUrl) throw new Error("chatUrl is required")
    if (!options.model) throw new Error("model is required")
    this.chatUrl = options.chatUrl
    this.model = options.model
    this.apiKeys = options.apiKeys
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxOutputTokens = options.maxOutputTokens ?? 512
    this.writerMaxOutputTokens = options.writerMaxOutputTokens ?? 1024
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.onUsage = options.onUsage
  }

  async classifyTier1(payload: Record<string, unknown>): Promise<Tier1Result> {
    return this.judgeCall(TIER1_OLLAMA_SYSTEM_PROMPT, payload, parseTier1Json)
  }

  async completeGoalEnrichment(prompt: string, timeoutMs: number): Promise<string> {
    const response = await this.postMessages({
      user: prompt,
      maxTokens: GOAL_ENRICHMENT_MAX_TOKENS,
      timeoutMs,
    })
    return withResponseDebug(response, "claude goal enrichment", () => claudeContent(response))
  }

  async confirmTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_LEGACY_SYSTEM_PROMPT,
  ): Promise<Tier2Result> {
    return this.judgeCall(systemPrompt, payload, parseTier2Json)
  }

  async decideTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_JUDGE_SYSTEM_PROMPT,
  ): Promise<Tier2Decision> {
    return this.judgeCall(systemPrompt, payload, parseTier2DecisionJson)
  }

  // opts.temperature is accepted for interface parity but never sent — current Claude
  // models reject non-default sampling parameters.
  async writeTier2Message(
    payload: Record<string, unknown>,
    systemPrompt: string,
    _opts: { temperature?: number } = {},
  ): Promise<string> {
    const response = await this.postMessages({
      system: systemPrompt,
      user: JSON.stringify(payload),
      maxTokens: this.writerMaxOutputTokens,
    })
    return withResponseDebug(response, "claude tier2 writer", () => {
      const content = claudeContent(response).trim()
      if (claudeExhausted(response)) {
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
    systemPrompt: string,
    payload: Record<string, unknown>,
    parser: (content: string) => T,
  ): Promise<T> {
    const response = await this.postMessages({
      system: systemPrompt,
      user: JSON.stringify(payload),
      maxTokens: this.maxOutputTokens,
    })
    return withResponseDebug(response, "claude judge", () => (
      parseJudgeContent(claudeContent(response), claudeExhausted(response), parser)
    ))
  }

  private async postMessages(options: {
    system?: string
    user: string
    maxTokens: number
    timeoutMs?: number
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: options.user }],
    }
    if (options.system) body.system = options.system
    const response = await postJsonRotating({
      url: this.chatUrl,
      body,
      debugContext: "claude transport",
      keys: rotated(this.apiKeys, this.rotation++),
      // Extension service workers with host_permissions bypass CORS, but the browser-access
      // header keeps this working under plain CORS too (e.g. the replay page).
      headersFor: (key) => ({
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      }),
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
    this.onUsage(num(usage.input_tokens), num(usage.output_tokens))
  }
}

export function claudeContent(response: Record<string, unknown>): string {
  const content = response.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string"
      ) {
        return (block as Record<string, unknown>).text as string
      }
    }
  }
  throw new ProviderResponseError("envelope", "claude response had no text block")
}

export function claudeExhausted(response: Record<string, unknown>): boolean {
  return response.stop_reason === "max_tokens"
}

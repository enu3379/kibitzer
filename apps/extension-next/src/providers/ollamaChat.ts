import {
  ProviderHttpError,
  ProviderResponseError,
} from "./errors.ts"
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

const GOAL_ENRICHMENT_NUM_PREDICT = 512
const GOAL_ENRICHMENT_THINKING_NUM_PREDICT = 2048
const RETRYABLE_KEY_STATUSES = new Set([401, 403, 429])

interface OllamaMessage {
  role: "system" | "user"
  content: string
}

interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  stream: false
  options: {
    temperature: 0
    num_predict: number
  }
  format?: "json"
  think?: boolean
}

export interface OllamaChatJudgeOptions {
  apiUrl: string
  model: string
  apiKey?: string
  fallbackApiKey?: string
  apiKeys?: readonly string[]
  timeoutMs?: number
  maxOutputTokens?: number
  writerMaxOutputTokens?: number
  fetch?: typeof fetch
}

export class OllamaChatJudgeProvider implements JudgeProvider {
  private readonly apiUrl: string
  private readonly model: string
  private readonly apiKey: string
  private readonly fallbackApiKey?: string
  private readonly apiKeys?: readonly string[]
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly writerMaxOutputTokens: number
  private readonly fetchFn: typeof fetch
  private rotation = 0

  constructor(options: OllamaChatJudgeOptions) {
    if (!options.apiUrl) throw new Error("Ollama apiUrl is required")
    if (!options.model) throw new Error("Ollama model is required")
    this.apiUrl = options.apiUrl
    this.model = options.model
    this.apiKey = options.apiKey ?? ""
    this.fallbackApiKey = options.fallbackApiKey
    this.apiKeys = options.apiKeys
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxOutputTokens = options.maxOutputTokens ?? 512
    this.writerMaxOutputTokens = options.writerMaxOutputTokens ?? 1024
    // Bind to the global scope: this.fetchFn(...) would otherwise call fetch with
    // `this` = the provider, which throws "Illegal invocation" in a service worker.
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async classifyTier1(payload: Record<string, unknown>): Promise<Tier1Result> {
    const response = await this.postChat([
      { role: "system", content: TIER1_OLLAMA_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ])
    return parseJudgeResponse(
      response,
      this.maxOutputTokens,
      parseTier1Json,
    )
  }

  async completeGoalEnrichment(prompt: string, timeoutMs: number): Promise<string> {
    const messages: OllamaMessage[] = [{ role: "user", content: prompt }]
    try {
      const response = await this.postChat(messages, {
        timeoutMs,
        think: false,
        numPredict: GOAL_ENRICHMENT_NUM_PREDICT,
      })
      return messageContent(response)
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error
      const response = await this.postChat(messages, {
        timeoutMs,
        numPredict: GOAL_ENRICHMENT_THINKING_NUM_PREDICT,
      })
      return messageContent(response)
    }
  }

  async confirmTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_LEGACY_SYSTEM_PROMPT,
  ): Promise<Tier2Result> {
    const response = await this.postChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) },
    ])
    return parseJudgeResponse(
      response,
      this.maxOutputTokens,
      parseTier2Json,
    )
  }

  async decideTier2(
    payload: Record<string, unknown>,
    systemPrompt = TIER2_JUDGE_SYSTEM_PROMPT,
  ): Promise<Tier2Decision> {
    const response = await this.postChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      {
        numPredict: this.maxOutputTokens,
        jsonMode: true,
      },
    )
    return parseJudgeResponse(
      response,
      this.maxOutputTokens,
      parseTier2DecisionJson,
    )
  }

  async writeTier2Message(
    payload: Record<string, unknown>,
    systemPrompt: string,
  ): Promise<string> {
    const response = await this.postChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      {
        think: false,
        numPredict: this.writerMaxOutputTokens,
        jsonMode: false,
      },
    )
    const content = messageContent(response).trim()
    if (outputBudgetExhausted(response, this.writerMaxOutputTokens)) {
      throw new ProviderResponseError(
        "output_exhausted",
        "tier2 writer response exhausted output budget",
      )
    }
    if (!content) {
      throw new ProviderResponseError("writer_empty", "tier2 writer response was empty")
    }
    return truncateCodePoints(content, 320)
  }

  private async postChat(
    messages: OllamaMessage[],
    options: {
      timeoutMs?: number
      think?: boolean
      numPredict?: number
      jsonMode?: boolean
    } = {},
  ): Promise<Record<string, unknown>> {
    const requestBody: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: 0,
        num_predict: options.numPredict ?? this.maxOutputTokens,
      },
    }
    if (options.jsonMode ?? true) requestBody.format = "json"
    if (options.think !== undefined) requestBody.think = options.think

    const keys = this.orderedApiKeys()
    let lastStatus: number | null = null
    for (let index = 0; index < keys.length; index += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? this.timeoutMs,
      )
      let response: Response
      try {
        const key = keys[index] ?? ""
        const headers: Record<string, string> = {
          "content-type": "application/json",
        }
        if (key) headers.authorization = `Bearer ${key}`
        response = await this.fetchFn(this.apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      lastStatus = response.status
      if (
        RETRYABLE_KEY_STATUSES.has(response.status)
        && index + 1 < keys.length
      ) {
        continue
      }
      if (!response.ok) throw new ProviderHttpError(response.status)
      return responseJson(response)
    }
    throw new ProviderHttpError(lastStatus ?? 500)
  }

  private orderedApiKeys(): string[] {
    const pool = (this.apiKeys ?? []).filter(Boolean)
    if (pool.length > 1) {
      const start = this.rotation % pool.length
      this.rotation += 1
      return [...pool.slice(start), ...pool.slice(0, start)]
    }
    if (pool.length === 1) return [pool[0]]
    const fixed = [this.apiKey]
    if (this.fallbackApiKey) fixed.push(this.fallbackApiKey)
    return fixed
  }
}

export function messageContent(response: Record<string, unknown>): string {
  const message = response.message
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content
    if (typeof content === "string") return content
  }
  if (typeof response.response === "string") return response.response
  throw new ProviderResponseError(
    "envelope",
    "Ollama response did not include message content",
  )
}

export function outputBudgetExhausted(
  response: Record<string, unknown>,
  maxOutputTokens: number,
): boolean {
  const evalCount = response.eval_count
  const pinned =
    typeof evalCount === "number"
    && Number.isInteger(evalCount)
    && evalCount >= maxOutputTokens
  return response.done_reason === "length" || pinned
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new ProviderResponseError("http_json", "provider HTTP body was not JSON")
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProviderResponseError("envelope", "provider response was not a JSON object")
  }
  return data as Record<string, unknown>
}

function parseJudgeResponse<T>(
  response: Record<string, unknown>,
  maxOutputTokens: number,
  parser: (content: string) => T,
): T {
  const content = messageContent(response)
  const exhausted = outputBudgetExhausted(response, maxOutputTokens)
  try {
    return parser(content)
  } catch (error) {
    if (
      exhausted
      && error instanceof ProviderResponseError
      && (error.stage === "content_json" || error.stage === "schema")
    ) {
      throw new ProviderResponseError(
        "output_exhausted",
        "judge response exhausted output budget",
      )
    }
    throw error
  }
}

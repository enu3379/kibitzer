import { listExplorationHistory } from "./history.ts"
import { ProviderResponseError } from "../providers/errors.ts"
import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import { buildTier1Payload } from "../providers/payloads.ts"
import {
  WasmEmbeddingProvider,
  extensionEmbeddingAssets,
} from "../providers/tier0Wasm.ts"
import type { JudgeVerdict } from "../providers/types.ts"

export const PROVIDER_SHADOW_CONFIG_KEY = "kibitzer:ts-provider-config:v1"
export const PROVIDER_SHADOW_SNAPSHOT_KEY = "kibitzer:ts-provider-shadow:v1"

export interface OllamaShadowConfig {
  enabled: boolean
  apiUrl: string
  model: string
  apiKey?: string
  fallbackApiKey?: string
  apiKeys?: string[]
  timeoutMs: number
  maxOutputTokens: number
  writerMaxOutputTokens: number
}

export interface ProviderShadowConfig {
  version: 1
  tier0: {
    enabled: boolean
    tauOk: number
  }
  tier1: OllamaShadowConfig | null
  tier2: OllamaShadowConfig | null
}

export interface ProviderShadowCheck {
  observationId: string
  pageKey: string
  title: string
  checkedAt: number
  durationMs: number
  result: "success" | "error"
  stage?: string
}

export interface ProviderShadowTier0Check extends ProviderShadowCheck {
  score?: number
  verdict?: JudgeVerdict
  serverVerdict: JudgeVerdict
}

export interface ProviderShadowTier1Check extends ProviderShadowCheck {
  verdict?: JudgeVerdict
  reason?: string
  serverVerdict: JudgeVerdict
}

export interface ProviderShadowSnapshot {
  version: 1
  sessionId: string
  tier0: ProviderShadowTier0Check | null
  tier1: ProviderShadowTier1Check | null
}

export interface ProviderShadowNavigation {
  sessionId: string
  observationId: string
  goal: string
  title: string
  url: string
  serverVerdict: JudgeVerdict
}

/**
 * Phase-4 diagnostics only. Provider outputs are persisted for inspection but
 * never dispatched into the gauge and never deliver effects. The Python path
 * remains authoritative until Phase 5.
 */
export class ProviderShadowRunner {
  private tail: Promise<void> = Promise.resolve()
  private generation = 0
  private tier0Provider: WasmEmbeddingProvider | null = null
  private tier1Provider: OllamaChatJudgeProvider | null = null
  private tier1Fingerprint: string | null = null

  runNavigation(input: ProviderShadowNavigation): Promise<void> {
    const generation = ++this.generation
    const task = async () => {
      if (generation !== this.generation) return
      const config = await this.config()
      const existing = await this.snapshot(input.sessionId)
      const tier0Done =
        !config.tier0.enabled
        || existing?.tier0?.observationId === input.observationId
      const tier1Done =
        !config.tier1
        || existing?.tier1?.observationId === input.observationId
      if (tier0Done && tier1Done) return
      if (!tier0Done) {
        await this.runTier0(input, config, existing, generation)
      }
      if (generation !== this.generation || tier1Done || !config.tier1) return
      await this.runTier1(input, config.tier1, generation)
    }
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }

  async snapshot(sessionId?: string): Promise<ProviderShadowSnapshot | null> {
    const stored = await chrome.storage.session.get(PROVIDER_SHADOW_SNAPSHOT_KEY)
    const snapshot = parseProviderShadowSnapshot(
      stored[PROVIDER_SHADOW_SNAPSHOT_KEY],
    )
    if (sessionId && snapshot?.sessionId !== sessionId) return null
    return snapshot
  }

  async clear(): Promise<void> {
    this.generation += 1
    await chrome.storage.session.remove(PROVIDER_SHADOW_SNAPSHOT_KEY)
  }

  private async runTier0(
    input: ProviderShadowNavigation,
    config: ProviderShadowConfig,
    existing: ProviderShadowSnapshot | null,
    generation: number,
  ): Promise<void> {
    const started = performance.now()
    const base = checkBase(input, started)
    let check: ProviderShadowTier0Check
    try {
      if (!this.tier0Provider) {
        this.tier0Provider = new WasmEmbeddingProvider({
          assets: extensionEmbeddingAssets(),
        })
      }
      const [goal, title] = await this.tier0Provider.embed([
        input.goal,
        input.title,
      ])
      const score = cosine(goal, title)
      check = {
        ...base(),
        result: "success",
        score,
        verdict: score >= config.tier0.tauOk ? "OK" : "DRIFT",
        serverVerdict: input.serverVerdict,
      }
    } catch (error) {
      check = {
        ...base(),
        result: "error",
        stage: safeFailureStage(error),
        serverVerdict: input.serverVerdict,
      }
    }
    await this.save({
      version: 1,
      sessionId: input.sessionId,
      tier0: check,
      tier1: existing?.sessionId === input.sessionId ? existing.tier1 : null,
    }, generation)
  }

  private async runTier1(
    input: ProviderShadowNavigation,
    config: OllamaShadowConfig,
    generation: number,
  ): Promise<void> {
    const started = performance.now()
    const base = checkBase(input, started)
    let check: ProviderShadowTier1Check
    try {
      const provider = this.tier1(config)
      const recent = (await listExplorationHistory()).slice(0, 5).map((item) => ({
        title: item.title,
        verdict: item.userVerdict ?? item.verdict ?? null,
      }))
      const urlHost = new URL(input.url).hostname
      const result = await provider.classifyTier1(buildTier1Payload(
        { rawText: input.goal },
        { title: input.title, urlHost },
        recent,
      ))
      check = {
        ...base(),
        result: "success",
        verdict: result.verdict,
        reason: result.reason,
        serverVerdict: input.serverVerdict,
      }
    } catch (error) {
      check = {
        ...base(),
        result: "error",
        stage: safeFailureStage(error),
        serverVerdict: input.serverVerdict,
      }
    }
    const existing = await this.snapshot(input.sessionId)
    await this.save({
      version: 1,
      sessionId: input.sessionId,
      tier0: existing?.tier0 ?? null,
      tier1: check,
    }, generation)
  }

  private tier1(config: OllamaShadowConfig): OllamaChatJudgeProvider {
    const fingerprint = JSON.stringify(config)
    if (!this.tier1Provider || this.tier1Fingerprint !== fingerprint) {
      this.tier1Provider = new OllamaChatJudgeProvider({
        apiUrl: config.apiUrl,
        model: config.model,
        apiKey: config.apiKey,
        fallbackApiKey: config.fallbackApiKey,
        apiKeys: config.apiKeys,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: config.maxOutputTokens,
        writerMaxOutputTokens: config.writerMaxOutputTokens,
      })
      this.tier1Fingerprint = fingerprint
    }
    return this.tier1Provider
  }

  private async config(): Promise<ProviderShadowConfig> {
    const stored = await chrome.storage.local.get(PROVIDER_SHADOW_CONFIG_KEY)
    return parseProviderShadowConfig(stored[PROVIDER_SHADOW_CONFIG_KEY])
  }

  private async save(
    snapshot: ProviderShadowSnapshot,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return
    await chrome.storage.session.set({
      [PROVIDER_SHADOW_SNAPSHOT_KEY]: snapshot,
    })
  }
}

export function parseProviderShadowConfig(value: unknown): ProviderShadowConfig {
  const object = isObject(value) ? value : {}
  const tier0 = isObject(object.tier0) ? object.tier0 : {}
  return {
    version: 1,
    tier0: {
      enabled: tier0.enabled !== false,
      // Recalibrated for the O4 ONNX export (2026-07-23): its FPR<=10% operating
      // point on the 200-pair v2 benchmark is 0.587 (qint8 was 0.597 -> 0.6). See
      // docs/benchmarks/tier0-embedding-o4/. Rounded to 0.59.
      tauOk: clampFloat(tier0.tauOk, 0.59, 0, 1),
    },
    tier1: parseOllamaConfig(object.tier1),
    tier2: parseOllamaConfig(object.tier2),
  }
}

export function parseProviderShadowSnapshot(
  value: unknown,
): ProviderShadowSnapshot | null {
  if (!isObject(value) || value.version !== 1 || typeof value.sessionId !== "string") {
    return null
  }
  if (!isTier0Check(value.tier0) || !isTier1Check(value.tier1)) return null
  return value as unknown as ProviderShadowSnapshot
}

function parseOllamaConfig(value: unknown): OllamaShadowConfig | null {
  if (!isObject(value) || value.enabled !== true) return null
  if (typeof value.apiUrl !== "string" || typeof value.model !== "string") return null
  const model = value.model.trim()
  let url: URL
  try {
    url = new URL(value.apiUrl)
  } catch {
    return null
  }
  if (!model || (url.protocol !== "http:" && url.protocol !== "https:")) return null
  const apiKeys = Array.isArray(value.apiKeys)
    ? value.apiKeys.filter((key): key is string => typeof key === "string" && Boolean(key))
    : undefined
  return {
    enabled: true,
    apiUrl: url.toString(),
    model,
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(typeof value.fallbackApiKey === "string"
      ? { fallbackApiKey: value.fallbackApiKey }
      : {}),
    ...(apiKeys?.length ? { apiKeys } : {}),
    timeoutMs: clampInt(value.timeoutMs, 120_000, 100, 300_000),
    maxOutputTokens: clampInt(value.maxOutputTokens, 512, 1, 16_384),
    writerMaxOutputTokens: clampInt(
      value.writerMaxOutputTokens,
      1024,
      1,
      16_384,
    ),
  }
}

function checkBase(input: ProviderShadowNavigation, started: number) {
  const pageKey = (() => {
    try {
      return new URL(input.url).hostname
    } catch {
      return ""
    }
  })()
  return (): ProviderShadowCheck => ({
    observationId: input.observationId,
    pageKey,
    title: input.title,
    checkedAt: Date.now(),
    durationMs: Math.max(0, performance.now() - started),
    result: "success",
  })
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("embedding dimensions differ")
  return left.reduce((sum, value, index) => sum + value * right[index], 0)
}

function safeFailureStage(error: unknown): string {
  if (error instanceof ProviderResponseError) return error.stage
  if (error instanceof DOMException && error.name === "AbortError") return "timeout"
  return "runtime"
}

function isTier0Check(value: unknown): boolean {
  return value === null || (
    isObject(value)
    && isCheckBase(value)
    && (value.serverVerdict === "OK" || value.serverVerdict === "DRIFT")
    && (value.verdict === undefined || value.verdict === "OK" || value.verdict === "DRIFT")
    && (value.score === undefined || isFiniteNumber(value.score))
  )
}

function isTier1Check(value: unknown): boolean {
  return value === null || (
    isObject(value)
    && isCheckBase(value)
    && (value.serverVerdict === "OK" || value.serverVerdict === "DRIFT")
    && (value.verdict === undefined || value.verdict === "OK" || value.verdict === "DRIFT")
    && (value.reason === undefined || typeof value.reason === "string")
  )
}

function isCheckBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.observationId === "string"
    && typeof value.pageKey === "string"
    && typeof value.title === "string"
    && isFiniteNumber(value.checkedAt)
    && isFiniteNumber(value.durationMs)
    && (value.result === "success" || value.result === "error")
    && (value.stage === undefined || typeof value.stage === "string")
  )
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function clampFloat(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

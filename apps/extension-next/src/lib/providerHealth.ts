// Surfaces LLM provider health so a mid-session failure (expired key, 429, 403, timeout)
// isn't silent. tier12 records ok/error on each call; the popup shows a warning and that
// Kibitzer has fallen back to Tier-0-only judging. Mirrors the server's provider-call
// status tracking (apps/server/app/core/runtime_resources.py).

import { ProviderHttpError, ProviderResponseError } from "../providers/errors.ts"

const KEY = "kibitzer:provider-health:v1"

export interface ProviderHealth {
  ok: boolean
  kind: string
  message: string
  ts: number
}

/** Classify a provider failure into a short kind + Korean note. Never includes the
 *  provider body or credentials (the error types already strip those). */
export function classifyProviderError(error: unknown): { kind: string; message: string } {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return { kind: "auth", message: "API 키 인증 실패 (키 확인 필요)" }
    if (error.status === 429) return { kind: "rate_limited", message: "요청 한도 초과 (429)" }
    if (error.status >= 500) return { kind: "server", message: `서버 오류 (${error.status})` }
    return { kind: "http", message: `HTTP ${error.status}` }
  }
  if (error instanceof ProviderResponseError) {
    if (error.stage === "output_exhausted") return { kind: "output", message: "응답 예산 초과 (출력 토큰 부족)" }
    return { kind: "response", message: `응답 파싱 실패 (${error.stage})` }
  }
  if (error instanceof Error && error.name === "AbortError") return { kind: "timeout", message: "응답 시간 초과" }
  return { kind: "error", message: String(error).slice(0, 80) }
}

export async function recordProviderOk(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: { ok: true, kind: "", message: "", ts: Date.now() } })
}

export async function recordProviderError(error: unknown): Promise<void> {
  const { kind, message } = classifyProviderError(error)
  await chrome.storage.local.set({ [KEY]: { ok: false, kind, message, ts: Date.now() } })
}

export async function getProviderHealth(): Promise<ProviderHealth | null> {
  const stored = await chrome.storage.local.get(KEY)
  const value = stored[KEY]
  return value && typeof value.ok === "boolean" ? (value as ProviderHealth) : null
}

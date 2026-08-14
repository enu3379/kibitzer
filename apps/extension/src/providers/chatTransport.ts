// Shared HTTP plumbing for the OpenAI-format and Claude wire adapters: key-pool
// rotation on auth/limit statuses, an abort window that covers the body read, and
// judge-content parsing with the output-budget escalation. Mirrors the behaviour
// ollamaChat.ts established (that file keeps its own copy — it predates this module
// and is covered by its own tests).

import { ProviderHttpError, ProviderResponseError } from "./errors.ts"
import { readProviderJson } from "./responseDebug.ts"

const RETRYABLE_KEY_STATUSES = new Set([401, 403, 429])

export interface RotatingPostOptions {
  url: string
  body: Record<string, unknown>
  debugContext: string
  keys: readonly string[]
  headersFor: (key: string) => Record<string, string>
  timeoutMs: number
  fetchFn: typeof fetch
}

/** POST the body once per key (in rotation order) until a key is not rejected with
 *  401/403/429. The abort timer covers the body read — a server that sends headers
 *  then stalls the body must not hang the serialized judge pipeline. */
export async function postJsonRotating(
  options: RotatingPostOptions,
): Promise<Record<string, unknown>> {
  const keys = options.keys.filter(Boolean)
  if (keys.length === 0) throw new ProviderHttpError(401)
  let lastStatus: number | null = null
  for (let index = 0; index < keys.length; index += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await options.fetchFn(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headersFor(keys[index]) },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      })
      lastStatus = response.status
      if (RETRYABLE_KEY_STATUSES.has(response.status) && index + 1 < keys.length) {
        continue
      }
      if (!response.ok) throw new ProviderHttpError(response.status)
      return await readProviderJson(response, options.debugContext)
    } finally {
      clearTimeout(timeout)
    }
  }
  throw new ProviderHttpError(lastStatus ?? 500)
}

/** Run the JSON-verdict parser; when the output budget was exhausted, surface parse
 *  failures as output_exhausted so callers can tell truncation from a bad verdict. */
export function parseJudgeContent<T>(
  content: string,
  exhausted: boolean,
  parser: (content: string) => T,
): T {
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

/** Rotate the pool start so a key exhausted by the previous call is not always hit first. */
export function rotated(keys: readonly string[], rotation: number): string[] {
  const pool = keys.filter(Boolean)
  if (pool.length <= 1) return [...pool]
  const start = rotation % pool.length
  return [...pool.slice(start), ...pool.slice(0, start)]
}

// Local token-usage ledger (options mockup v5): every judge/writer response's usage
// field is folded into a day × provider/model bucket. Tokens and call counts only —
// no cost estimation (price tables go stale, custom models have unknown prices, and
// Ollama Cloud meters GPU time, not tokens). Kept 30 days, local-only.

import type { ProviderId } from "./providers.ts"

const USAGE_KEY = "kibitzer:usage:v1"
const RETENTION_DAYS = 30

interface Bucket {
  c: number // calls
  i: number // tokens in
  o: number // tokens out
}

/** { "2026-07-28": { "ollama/minimax-m3": {c,i,o}, ... }, ... } */
type UsageStore = Record<string, Record<string, Bucket>>

export interface UsageRow {
  provider: ProviderId
  model: string
  calls: number
  tokensIn: number
  tokensOut: number
}

function localDay(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function coerceStore(value: unknown): UsageStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as UsageStore
}

// Judge calls are serialized in the pipeline, but the popup/options can trigger tests
// concurrently — chain writes so a read-modify-write never drops a bucket.
let writeQueue: Promise<void> = Promise.resolve()

export function recordUsage(
  provider: ProviderId,
  model: string,
  tokensIn: number,
  tokensOut: number,
  now: number = Date.now(),
): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const stored = await chrome.storage.local.get(USAGE_KEY)
    const store = coerceStore(stored[USAGE_KEY])
    const day = localDay(now)
    const cutoff = localDay(now - RETENTION_DAYS * 86_400_000)
    for (const key of Object.keys(store)) {
      if (key < cutoff) delete store[key]
    }
    const buckets = (store[day] ??= {})
    const bucket = (buckets[`${provider}/${model}`] ??= { c: 0, i: 0, o: 0 })
    bucket.c += 1
    bucket.i += tokensIn
    bucket.o += tokensOut
    await chrome.storage.local.set({ [USAGE_KEY]: store })
  })
  return writeQueue
}

/** Aggregate the last `days` local days (today inclusive), busiest models first. */
export async function getUsage(days: number, now: number = Date.now()): Promise<UsageRow[]> {
  const stored = await chrome.storage.local.get(USAGE_KEY)
  const store = coerceStore(stored[USAGE_KEY])
  const from = localDay(now - (days - 1) * 86_400_000)
  const totals = new Map<string, Bucket>()
  for (const [day, buckets] of Object.entries(store)) {
    if (day < from) continue
    for (const [modelKey, bucket] of Object.entries(buckets)) {
      const total = totals.get(modelKey) ?? { c: 0, i: 0, o: 0 }
      total.c += bucket.c
      total.i += bucket.i
      total.o += bucket.o
      totals.set(modelKey, total)
    }
  }
  return [...totals.entries()]
    .map(([modelKey, b]) => {
      const slash = modelKey.indexOf("/")
      return {
        provider: modelKey.slice(0, slash) as ProviderId,
        model: modelKey.slice(slash + 1),
        calls: b.c,
        tokensIn: b.i,
        tokensOut: b.o,
      }
    })
    .sort((a, b) => b.calls - a.calls)
}

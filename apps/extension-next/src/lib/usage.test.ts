// Usage ledger: day×model bucketing, period aggregation, and 30-day pruning.
// chrome.storage.local stubbed in-memory.

import assert from "node:assert/strict"
import test from "node:test"

const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
    },
  },
}

const { getUsage, recordUsage } = await import("./usage.ts")

const DAY = 86_400_000
// Fixed local noon so day boundaries don't wobble with the test machine's timezone.
const NOW = new Date(2026, 6, 28, 12, 0, 0).getTime()

function reset(): void {
  for (const key of Object.keys(store)) delete store[key]
}

test("calls accumulate into per-model buckets and aggregate busiest-first", async () => {
  reset()
  await recordUsage("ollama", "nemotron-3-super", 1000, 50, NOW)
  await recordUsage("ollama", "nemotron-3-super", 500, 25, NOW)
  await recordUsage("ollama", "minimax-m3", 3000, 400, NOW)

  const rows = await getUsage(1, NOW)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    provider: "ollama",
    model: "nemotron-3-super",
    calls: 2,
    tokensIn: 1500,
    tokensOut: 75,
  })
  assert.equal(rows[1].model, "minimax-m3")
})

test("period windows include exactly the last N local days", async () => {
  reset()
  await recordUsage("ollama", "m", 10, 1, NOW - 8 * DAY)
  await recordUsage("ollama", "m", 20, 2, NOW - 6 * DAY)
  await recordUsage("ollama", "m", 40, 4, NOW)

  const today = await getUsage(1, NOW)
  assert.equal(today[0].tokensIn, 40)
  const week = await getUsage(7, NOW)
  assert.equal(week[0].tokensIn, 60) // 6일 전 + 오늘, 8일 전 제외
  const month = await getUsage(30, NOW)
  assert.equal(month[0].tokensIn, 70)
})

test("provider/model keys with slashes in the model survive the round-trip", async () => {
  reset()
  await recordUsage("openrouter", "upstage/solar-pro-3", 100, 10, NOW)
  const rows = await getUsage(1, NOW)
  assert.equal(rows[0].provider, "openrouter")
  assert.equal(rows[0].model, "upstage/solar-pro-3")
})

test("buckets older than 30 days are pruned on write", async () => {
  reset()
  await recordUsage("ollama", "m", 10, 1, NOW - 40 * DAY)
  await recordUsage("ollama", "m", 20, 2, NOW) // triggers the prune
  const usageStore = store["kibitzer:usage:v1"] as Record<string, unknown>
  assert.equal(Object.keys(usageStore).length, 1)
  const month = await getUsage(30, NOW)
  assert.equal(month[0].tokensIn, 20)
})

test("concurrent records do not drop updates", async () => {
  reset()
  await Promise.all(
    Array.from({ length: 10 }, () => recordUsage("zai", "glm-4.7-flash", 100, 10, NOW)),
  )
  const rows = await getUsage(1, NOW)
  assert.equal(rows[0].calls, 10)
  assert.equal(rows[0].tokensIn, 1000)
})

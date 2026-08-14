// Integration test for the end-of-session summary lifecycle over real IndexedDB semantics
// (fake-indexeddb): finalize snapshots the stats, the async recap resolves the pending
// comment under an epoch+pending guard (so a late result can't leak into a newer session),
// a stale pending is promoted to fallback on read, and dismissal survives.
// chrome.storage.local (Ollama config lookup — no keys → static fallback path) is stubbed.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
      remove: async (key: string) => void delete store[key],
    },
  },
}

const { clearVisits, noteInactive, noteJudged } = await import("./visits.ts")
const {
  clearSessionSummary,
  dismissSessionSummary,
  finalizeSession,
  generateSummaryComment,
  getSessionSummary,
} = await import("./sessionSummary.ts")

const goal = (epoch: number) => ({
  text: "논문 정리",
  availableMinutes: null,
  startedAt: 0,
  revision: 0,
  epoch,
})

test("finalize → generate resolves the pending comment from the tracked visits", async () => {
  await clearVisits()
  await clearSessionSummary()
  await noteJudged("a", "리뷰", "a.test", "OK", 0, 5)
  await noteJudged("b", "쇼츠", "b.test", "DRIFT", 60_000, 5)
  await noteInactive(90_000, 5)

  const summary = await finalizeSession(goal(5), 120_000)
  assert.equal(summary.comment.status, "pending")
  assert.equal(summary.stats.pagesTotal, 2)
  assert.equal(summary.stats.pagesOk, 1)
  assert.equal(summary.stats.validMs, 60_000) // page a: 0→60s; page b's 30s was DRIFT
  assert.equal(summary.stats.topPage?.title, "리뷰")

  await generateSummaryComment(summary) // Ollama off → static fallback
  const resolved = await getSessionSummary(121_000)
  assert.equal(resolved?.comment.status, "fallback")
  assert.ok(resolved?.comment.text)

  await dismissSessionSummary()
  assert.equal((await getSessionSummary(121_000))?.seen, true)
})

test("a late recap result cannot resurrect a cleared summary or touch a newer epoch", async () => {
  await clearVisits()
  const first = await finalizeSession(goal(6), 1_000)

  // New session started before the recap landed → the cached summary was cleared.
  await clearSessionSummary()
  await generateSummaryComment(first)
  assert.equal(await getSessionSummary(2_000), null, "cleared summary must stay gone")

  // A newer summary (different epoch) must not be resolved by the old epoch's recap.
  const second = await finalizeSession(goal(7), 3_000)
  await generateSummaryComment(first)
  const current = await getSessionSummary(4_000)
  assert.equal(current?.epoch, 7)
  assert.equal(current?.comment.status, "pending")

  await generateSummaryComment(second) // the matching epoch resolves it
  assert.equal((await getSessionSummary(5_000))?.comment.status, "fallback")
})

test("a stale pending recap is promoted to fallback on read (no infinite spinner)", async () => {
  await clearVisits()
  await noteJudged("a", "리뷰", "a.test", "OK", 0, 8)
  const summary = await finalizeSession(goal(8), 10_000)
  assert.equal(summary.comment.status, "pending")

  const fresh = await getSessionSummary(20_000) // within the deadline → still pending
  assert.equal(fresh?.comment.status, "pending")

  const promoted = await getSessionSummary(10_000 + 91_000)
  assert.equal(promoted?.comment.status, "fallback")
  assert.ok(promoted?.comment.text)
})

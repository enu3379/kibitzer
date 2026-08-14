import assert from "node:assert/strict"
import test from "node:test"

import { CARD_ORDER, type CardContext, MAX_CARDS, selectCards } from "./reportCards.ts"
import type { SessionComparison } from "./sessionHistory.ts"
import type { SessionReport } from "./sessionReport.ts"
import type { SessionStats } from "./sessionStats.ts"

const MIN = 60_000

const report = (over: Partial<SessionReport> = {}): SessionReport => ({
  distinctHosts: 6,
  avgPageMs: 5 * MIN,
  longestFocusMs: 20 * MIN,
  timeToFirstDriftMs: 18 * MIN,
  awayCount: 1,
  awayMs: 5 * MIN,
  nagCount: 3,
  nagActed: 2,
  goalMinutes: 60,
  activeMinutes: 62,
  driftVisits: 8,
  driftMs: 14 * MIN,
  topDriftHosts: [{ host: "instagram.com", label: "📷 인스타그램", friendly: { emoji: "📷", name: "인스타그램" }, ms: 8 * MIN, verdict: "DRIFT", visits: 5 }],
  longestDriftMs: 6 * MIN,
  avgDriftEpisodeMs: 3 * MIN,
  driftClock: "late",
  secondHalfTrend: "up",
  ending: "OK",
  lowestS: 31,
  mvp: { title: "리뷰", host: "velog.io", ms: 21 * MIN },
  villain: { host: "instagram.com", label: "📷 인스타그램", friendly: { emoji: "📷", name: "인스타그램" }, ms: 8 * MIN, verdict: "DRIFT", visits: 5 },
  siteBars: [
    { host: "velog.io", label: "velog.io", friendly: { emoji: "", name: "velog.io" }, ms: 21 * MIN, verdict: "OK", visits: 3 },
    { host: "arxiv.org", label: "arxiv.org", friendly: { emoji: "", name: "arxiv.org" }, ms: 18 * MIN, verdict: "OK", visits: 2 },
  ],
  sCurve: Array.from({ length: 24 }, (_, i) => 100 - i),
  ...over,
})

const stats = {} as SessionStats

const noHistory: SessionComparison = { sessions: 0, vsLast: null, vsAvg: null, lastSCurve: null, avgSCurve: null }
const withHistory: SessionComparison = {
  sessions: 3,
  vsLast: { okRatioDelta: 0.12, validMsDelta: 9 * MIN, driftVisitsDelta: -3 },
  vsAvg: { okRatioDelta: 0.07, validMsDelta: -4 * MIN, driftVisitsDelta: 0 },
  lastSCurve: Array.from({ length: 24 }, () => 50),
  avgSCurve: Array.from({ length: 24 }, () => 60),
}

const ctx = (over: Partial<CardContext> = {}): CardContext => ({ report: report(), stats, comparison: noHistory, ...over })

/** Deterministic PRNG so the sampling tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test("selects at most MAX_CARDS, all valid ids, no duplicates, in CARD_ORDER", () => {
  const rand = mulberry32(1)
  for (let i = 0; i < 50; i += 1) {
    const cards = selectCards(ctx({ comparison: withHistory }), rand)
    assert.ok(cards.length <= MAX_CARDS)
    assert.equal(new Set(cards).size, cards.length)
    for (const id of cards) assert.ok((CARD_ORDER as readonly string[]).includes(id))
    const orderIdx = cards.map((id) => CARD_ORDER.indexOf(id))
    assert.deepEqual(orderIdx, [...orderIdx].sort((a, b) => a - b)) // rendered in CARD_ORDER
  }
})

test("the full pool genuinely rotates — not the same five every session", () => {
  const rand = mulberry32(42)
  const seen = new Set<string>()
  for (let i = 0; i < 200; i += 1) for (const id of selectCards(ctx({ comparison: withHistory }), rand)) seen.add(id)
  assert.ok(seen.size >= 9, `expected most of the 11-card pool to appear, saw ${seen.size}`)
})

test("interesting cards still lead — high-score cards appear far more often", () => {
  const rand = mulberry32(7)
  const count: Record<string, number> = {}
  for (let i = 0; i < 400; i += 1) for (const id of selectCards(ctx({ comparison: withHistory }), rand)) count[id] = (count[id] ?? 0) + 1
  // mischief (drift-heavy session, high score) should outshow gauge (low score) clearly.
  assert.ok((count.mischief ?? 0) > (count.gauge ?? 0) * 1.5)
})

test("comparison cards only appear once there is history", () => {
  const rand = mulberry32(3)
  for (let i = 0; i < 50; i += 1) {
    const cold = selectCards(ctx({ comparison: noHistory }), rand)
    assert.ok(!cold.includes("compare-last") && !cold.includes("compare-avg") && !cold.includes("scurve"))
  }
})

test("a clean, history-less session still fills cards from what it has", () => {
  const clean = report({
    driftVisits: 0,
    driftMs: 0,
    topDriftHosts: [],
    villain: null,
    longestDriftMs: 0,
    avgDriftEpisodeMs: null,
    ending: "OK",
  })
  const cards = selectCards({ report: clean, stats, comparison: noHistory }, mulberry32(9))
  assert.ok(cards.length >= 1)
  assert.ok(!cards.includes("mischief")) // no drift → not eligible
})

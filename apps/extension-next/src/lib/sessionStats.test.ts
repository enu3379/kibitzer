import assert from "node:assert/strict"
import test from "node:test"

import {
  bandOf,
  computeSessionStats,
  detectSpecial,
  formatDurationKo,
  type SessionStats,
} from "./sessionStats.ts"
import { emptyVisits, MAX_OPEN_MS, type SessionVisits, type VisitEntry } from "./visits.ts"

const EPOCH = 3
const GOAL = { text: "논문 정리", startedAt: 0, epoch: EPOCH }

function entry(pageKey: string, ms: number, verdict: "OK" | "DRIFT"): VisitEntry {
  return { pageKey, title: `T ${pageKey}`, host: `${pageKey}.test`, verdict, ms, lastSeen: 0 }
}

function visitsWith(entries: VisitEntry[], over: Partial<SessionVisits> = {}): SessionVisits {
  const v = emptyVisits(EPOCH)
  for (const e of entries) v.entries[e.pageKey] = e
  return { ...v, ...over }
}

test("zero judged pages: null ratio, no top page, minimum 1 session minute", () => {
  const stats = computeSessionStats(null, GOAL, 0, 30_000)
  assert.equal(stats.pagesTotal, 0)
  assert.equal(stats.okRatio, null)
  assert.equal(stats.topPage, null)
  assert.deepEqual(stats.topPages, [])
  assert.equal(stats.validMs, 0)
  assert.equal(stats.sessionMinutes, 1)
})

test("ratio / valid-time arithmetic includes the evicted aggregates", () => {
  const visits = visitsWith(
    [entry("a", 60_000, "OK"), entry("b", 30_000, "DRIFT")],
    { evicted: { pages: 2, okPages: 1, ms: 20_000, okMs: 15_000 } },
  )
  const stats = computeSessionStats(visits, GOAL, 2, 10 * 60_000)
  assert.equal(stats.pagesTotal, 4)
  assert.equal(stats.pagesOk, 2)
  assert.equal(stats.okRatio, 0.5)
  assert.equal(stats.validMs, 75_000)
  assert.equal(stats.activeMs, 110_000) // 60s + 30s entries + 20s evicted
  assert.equal(stats.nagCount, 2)
})

test("the open interval is virtually closed at `now` with the clamp", () => {
  const visits = visitsWith([entry("a", 10_000, "OK")], {
    open: { pageKey: "a", since: 100_000 },
  })
  const stats = computeSessionStats(visits, GOAL, 0, 130_000)
  assert.equal(stats.validMs, 40_000) // 10s + 30s open

  const stale = computeSessionStats(visits, GOAL, 0, 100_000 + 10 * 60_000)
  assert.equal(stale.validMs, 10_000 + MAX_OPEN_MS) // clamped
})

test("top pages are ordered by dwell and truncated to five", () => {
  const visits = visitsWith(
    [1, 2, 3, 4, 5, 6, 7].map((i) => entry(`p${i}`, i * 1_000, "OK")),
  )
  const stats = computeSessionStats(visits, GOAL, 0, 60_000)
  assert.equal(stats.topPage?.ms, 7_000)
  assert.equal(stats.topPages.length, 5)
  assert.deepEqual(
    stats.topPages.map((p) => p.ms),
    [7_000, 6_000, 5_000, 4_000, 3_000],
  )
})

test("visits from another epoch are ignored", () => {
  const visits = visitsWith([entry("a", 60_000, "OK")])
  const stats = computeSessionStats(visits, { ...GOAL, epoch: EPOCH + 1 }, 0, 60_000)
  assert.equal(stats.pagesTotal, 0)
})

test("formatDurationKo boundaries", () => {
  assert.equal(formatDurationKo(0), "1분 미만")
  assert.equal(formatDurationKo(59_000), "1분 미만")
  assert.equal(formatDurationKo(60_000), "1분")
  assert.equal(formatDurationKo(45 * 60_000), "45분")
  assert.equal(formatDurationKo(60 * 60_000), "1시간")
  assert.equal(formatDurationKo(83 * 60_000), "1시간 23분")
})

test("bandOf uses the gauge severity bands", () => {
  assert.equal(bandOf(100), "ok")
  assert.equal(bandOf(66), "ok")
  assert.equal(bandOf(65), "warn")
  assert.equal(bandOf(33), "warn")
  assert.equal(bandOf(32), "bad")
  assert.equal(bandOf(0), "bad")
})

const statsWith = (over: Partial<SessionStats>): SessionStats => ({
  goalText: "g",
  sessionMinutes: 10,
  activeMs: 0,
  pagesTotal: 10,
  pagesOk: 5,
  okRatio: 0.5,
  validMs: 0,
  nagCount: 2,
  topPage: null,
  topPages: [],
  endedAt: 0,
  ...over,
})

test("detectSpecial precedence: perfect > all_drift > no_nag > null", () => {
  assert.equal(detectSpecial(statsWith({ pagesTotal: 0, pagesOk: 0 })), null)
  assert.equal(detectSpecial(statsWith({ pagesOk: 10, nagCount: 0 })), "perfect")
  assert.equal(detectSpecial(statsWith({ pagesOk: 0, nagCount: 0 })), "all_drift")
  assert.equal(detectSpecial(statsWith({ nagCount: 0 })), "no_nag")
  assert.equal(detectSpecial(statsWith({})), null)
})

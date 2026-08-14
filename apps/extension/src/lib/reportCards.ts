// Which report cards to surface. Every card is always computed; a session shows only a
// handful, chosen by how interesting each is FOR THIS session plus a little randomness — so
// a drift-heavy session leads with the mischief card, a record session with the comparison,
// and repeat sessions vary. Pure; inject `rand` for tests.

import type { SessionComparison } from "./sessionHistory.ts"
import type { SessionReport } from "./sessionReport.ts"
import type { SessionStats } from "./sessionStats.ts"

export const MAX_CARDS = 5

// All card ids, in the order they should render when selected.
export const CARD_ORDER = [
  "compare-last",
  "compare-avg",
  "scurve",
  "mischief",
  "highlight",
  "focus",
  "recovery",
  "rhythm",
  "goalcard",
  "gauge",
  "sites",
] as const

export type CardId = (typeof CARD_ORDER)[number]

export interface CardContext {
  report: SessionReport
  stats: SessionStats
  comparison: SessionComparison
}

const MIN = 60_000

/** How strongly a delta stands out (drives whether a comparison card is worth showing). */
function deltaWeight(d: SessionComparison["vsLast"]): number {
  if (!d) return 0
  const ratio = d.okRatioDelta != null ? Math.abs(d.okRatioDelta) * 8 : 0 // 0.1pp → 0.8
  const drift = Math.abs(d.driftVisitsDelta) * 0.6
  const time = Math.abs(d.validMsDelta) / (10 * MIN) // 10min → 1
  return ratio + drift + time
}

/** Eligibility + base interest per card. 0 (or absent) means "cannot show this session". */
function baseScores(ctx: CardContext): Partial<Record<CardId, number>> {
  const { report: r, comparison: c } = ctx
  const scores: Partial<Record<CardId, number>> = {}
  const hasCurve = r.sCurve.length > 0

  if (c.vsLast) scores["compare-last"] = 5.5 + Math.min(4, deltaWeight(c.vsLast))
  if (c.vsAvg && c.sessions >= 2) scores["compare-avg"] = 4 + Math.min(3.5, deltaWeight(c.vsAvg))
  if (hasCurve && (c.lastSCurve || c.avgSCurve)) scores["scurve"] = 8

  if (r.driftVisits > 0) scores.mischief = 4.5 + Math.min(4, r.driftVisits / 2)
  if (r.mvp || r.villain) scores.highlight = 6
  if (r.siteBars.length >= 2) scores.sites = 4.5

  if (r.longestFocusMs > 0 || r.timeToFirstDriftMs != null) {
    scores.focus =
      3 + (r.longestFocusMs >= 15 * MIN ? 2 : 0) + (r.timeToFirstDriftMs != null && r.timeToFirstDriftMs < MIN ? 2 : 0)
  }
  if (r.avgDriftEpisodeMs != null || r.longestDriftMs > 0) {
    scores.recovery = 3 + (r.longestDriftMs >= 5 * MIN ? 2 : 0)
  }
  if (r.secondHalfTrend || r.driftClock) {
    scores.rhythm = 2.5 + (r.secondHalfTrend && r.secondHalfTrend !== "flat" ? 2 : 0)
  }
  if (r.goalMinutes != null || r.ending) {
    const goalOff = r.goalMinutes != null ? Math.min(3, Math.abs(r.activeMinutes / r.goalMinutes - 1) * 3) : 0
    scores.goalcard = 2.5 + goalOff + (r.ending === "DRIFT" ? 1 : 0)
  }
  if (r.lowestS != null || r.awayCount > 0) {
    scores.gauge = 2 + (r.lowestS != null && r.lowestS < 20 ? 3 : 0) + (r.awayCount >= 3 ? 1 : 0)
  }
  return scores
}

/** Pick up to MAX_CARDS cards by weighted random sampling WITHOUT replacement: each eligible
 *  card is drawn with probability proportional to its interestingness. Interesting cards lead
 *  most sessions, but the whole 11-card pool genuinely rotates in over time (a top-N-by-score
 *  cut would always surface the same five). Laid out in CARD_ORDER. */
export function selectCards(ctx: CardContext, rand: () => number = Math.random): CardId[] {
  const scores = baseScores(ctx)
  const remaining = (Object.keys(scores) as CardId[]).filter((id) => (scores[id] ?? 0) > 0)
  const picked: CardId[] = []
  while (picked.length < MAX_CARDS && remaining.length > 0) {
    const total = remaining.reduce((sum, id) => sum + (scores[id] ?? 0), 0)
    let threshold = rand() * total
    let idx = 0
    for (; idx < remaining.length - 1; idx += 1) {
      threshold -= scores[remaining[idx]] ?? 0
      if (threshold <= 0) break
    }
    picked.push(remaining[idx])
    remaining.splice(idx, 1)
  }
  return CARD_ORDER.filter((id) => picked.includes(id))
}

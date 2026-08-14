// End-of-session summary (P3-8): when the user ends a session, the stats are snapshotted
// BEFORE the gauge/history reset wipes their sources, and the Tier-2 persona recap is
// generated asynchronously. The summary lives in the kv store so the popup can close and
// reopen while the recap generates; starting a new session supersedes it.

import { kvDelete, kvGet, kvSet, kvUpdate } from "./db.ts"
import { getEvents } from "./events.ts"
import { sessionNagStats } from "./history.ts"
import { klog } from "./klog.ts"
import type { SessionGoal } from "./session.ts"
import {
  appendSessionHistory,
  computeComparison,
  getSessionHistory,
  type SessionComparison,
  type SessionHistoryEntry,
} from "./sessionHistory.ts"
import { type CardId, selectCards } from "./reportCards.ts"
import { computeReport, type SessionReport } from "./sessionReport.ts"
import {
  computeSessionStats,
  detectSpecial,
  formatDurationKo,
  type SessionStats,
} from "./sessionStats.ts"
import { rollSummaryDice } from "./summaryDice.ts"
import { writeSessionSummary } from "./tier12.ts"
import { getVisits } from "./visits.ts"

const SUMMARY_KEY = "session-summary"

// A pending recap older than this is promoted to the static fallback on read: the writer
// call either finished or died with the worker, and the popup must never spin forever.
const PENDING_DEADLINE_MS = 90_000

export type SummaryCommentStatus = "pending" | "ready" | "fallback"

export interface SessionSummary {
  epoch: number
  stats: SessionStats
  report: SessionReport
  comparison: SessionComparison // vs the previous session and the rolling average
  cards: CardId[] // which report cards to surface this session (all are computed)
  comment: { status: SummaryCommentStatus; text: string | null }
  seen: boolean
  createdAt: number
}

function isSummary(value: unknown): value is SessionSummary {
  const s = value as SessionSummary | undefined
  return Boolean(
    s &&
      typeof s.epoch === "number" &&
      typeof s.createdAt === "number" &&
      s.stats &&
      s.report &&
      s.comment &&
      typeof s.comment.status === "string",
  )
}

/** The biggest time-sink for the recap writer / fallback — null when the user never drifted. */
function topDriftHost(report: SessionReport): { label: string; visits: number } | null {
  const top = report.topDriftHosts[0]
  return top ? { label: top.label, visits: top.visits } : null
}

/** Snapshot the session's stats + extended report and store the summary record (recap still
 *  pending). MUST run before resetState(): the reset clears the nag log and the visit
 *  tracker (the events store survives, so the report's sequence stats are still readable). */
export async function finalizeSession(goal: SessionGoal, now: number): Promise<SessionSummary> {
  const [visits, events, nag, history] = await Promise.all([
    getVisits(),
    getEvents(),
    sessionNagStats(goal.startedAt),
    getSessionHistory(),
  ])
  const stats = computeSessionStats(visits, goal, nag.count, now)
  const report = computeReport(visits, events, nag, goal, now)
  const entry: SessionHistoryEntry = {
    epoch: goal.epoch,
    endedAt: now,
    okRatio: stats.okRatio,
    validMs: stats.validMs,
    activeMs: stats.activeMs,
    driftVisits: report.driftVisits,
    pagesTotal: stats.pagesTotal,
    nagCount: stats.nagCount,
    sCurve: report.sCurve,
  }
  const comparison = computeComparison(entry, history)
  const summary: SessionSummary = {
    epoch: goal.epoch,
    stats,
    report,
    comparison,
    cards: selectCards({ report, stats, comparison }),
    comment: { status: "pending", text: null },
    seen: false,
    createdAt: now,
  }
  await kvSet(SUMMARY_KEY, summary)
  // Record only meaningful sessions, AFTER computing the comparison (so this session isn't
  // compared against itself), so the next summary can compare against it.
  if (stats.pagesTotal > 0) await appendSessionHistory(entry)
  return summary
}

/** Resolve the pending recap, guarded so a late result can never leak into a newer
 *  summary (different epoch) or overwrite an already-resolved one. */
async function resolvePending(
  epoch: number,
  comment: SessionSummary["comment"],
): Promise<void> {
  await kvUpdate<SessionSummary | undefined>(SUMMARY_KEY, (current) => {
    if (!isSummary(current) || current.epoch !== epoch || current.comment.status !== "pending") {
      return current
    }
    return { ...current, comment }
  })
}

/** Generate the persona recap for a finalized summary (fire-and-forget from the handler).
 *  Captures the stats by value, so the session reset that follows finalize can't hurt it. */
export async function generateSummaryComment(summary: SessionSummary): Promise<void> {
  const drift = topDriftHost(summary.report)
  let text: string | null = null
  try {
    // No judged pages → nothing worth an LLM call; go straight to the static line.
    if (summary.stats.pagesTotal > 0) {
      text = await writeSessionSummary(summary.stats, rollSummaryDice(), drift)
    }
  } catch (error) {
    klog(`session summary generation error: ${String(error)}`) // writeSessionSummary already fails soft
  }
  const comment = text
    ? { status: "ready" as const, text }
    : { status: "fallback" as const, text: pickSummaryFallback(summary.stats, drift) }
  await resolvePending(summary.epoch, comment)
}

export async function getSessionSummary(now: number): Promise<SessionSummary | null> {
  const value = await kvGet<SessionSummary>(SUMMARY_KEY)
  if (!isSummary(value)) return null
  if (value.comment.status === "pending" && now - value.createdAt > PENDING_DEADLINE_MS) {
    await resolvePending(value.epoch, {
      status: "fallback",
      text: pickSummaryFallback(value.stats),
    })
    const promoted = await kvGet<SessionSummary>(SUMMARY_KEY)
    return isSummary(promoted) ? promoted : null
  }
  return value
}

/** The user closed the summary ("확인") — keep it, but don't reopen it on the next popup. */
export async function dismissSessionSummary(): Promise<void> {
  await kvUpdate<SessionSummary | undefined>(SUMMARY_KEY, (current) =>
    isSummary(current) ? { ...current, seen: true } : current,
  )
}

export async function clearSessionSummary(): Promise<void> {
  await kvDelete(SUMMARY_KEY)
}

// --- static fallback (④ pool + ⑤ event lines; no per-persona YAML templates) ------

/** Stats-derived recap when the LLM is off/failed. Every duration formatted by
 *  formatDurationKo ends in 분/시간/미만 (all with batchim), so a fixed 을/를 is safe. */
export function pickSummaryFallback(
  stats: SessionStats,
  drift: { label: string; visits: number } | null = null,
  rand: () => number = Math.random,
): string {
  if (stats.pagesTotal === 0) {
    return "판정할 페이지가 없었어요. 5초 이상 머문 페이지부터 집계됩니다."
  }
  const valid = formatDurationKo(stats.validMs)
  const special = detectSpecial(stats)
  if (special === "perfect") {
    return `판정된 ${stats.pagesTotal}페이지가 전부 유효 — 퍼펙트 세션이에요. ${valid}을 온전히 집중에 썼습니다.`
  }
  if (special === "all_drift") {
    return "이번엔 유효로 판정된 페이지가 없었어요. 다음 세션은 목표 첫 페이지부터 다시 시작해 보죠."
  }
  if (special === "no_nag") {
    return `훈수 한 번 없이 세션을 마쳤어요. ${stats.pagesTotal}페이지 중 ${stats.pagesOk}페이지 유효, ${valid} 집중.`
  }
  const top = stats.topPage
  const pool = [
    `${stats.pagesTotal}페이지 중 ${stats.pagesOk}페이지가 목표와 맞았어요. 집중한 시간은 ${valid}.`,
    `이번 세션 성적: 유효 ${stats.pagesOk}/${stats.pagesTotal}페이지, ${valid} 집중.`,
    `목표에 쓴 시간 ${valid}, 유효 페이지 ${stats.pagesOk}/${stats.pagesTotal}. 숫자는 여기까지, 해석은 다음 세션에서.`,
    top
      ? `가장 오래 머문 곳은 ${top.title || top.host} (${formatDurationKo(top.ms)}). 전체로는 ${stats.pagesOk}/${stats.pagesTotal}페이지가 유효였어요.`
      : `${valid}을 목표에 썼고, ${stats.pagesTotal}페이지 중 ${stats.pagesOk}페이지가 유효였어요.`,
  ]
  // When there's a clear time-sink, offer a drift-flavored variant too (rotates in with the rest).
  if (drift && drift.visits >= 2) {
    pool.push(
      `${stats.pagesOk}/${stats.pagesTotal}페이지 유효, ${valid} 집중. ${drift.label}에는 ${drift.visits}번 다녀오셨고요.`,
    )
  }
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}

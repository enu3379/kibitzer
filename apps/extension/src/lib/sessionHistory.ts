// Rolling history of finished sessions, so a summary can say "지난 세션보다 유효율 +12%p".
// Lives under its own kv key (NOT wiped by resetState — that only clears the live session),
// capped, and only meaningful sessions (≥1 judged page) are recorded. Pure comparison math
// is separated from the durable read/write for testing.

import { kvDelete, kvGet, kvUpdate } from "./db.ts"

const HISTORY_KEY = "session-history"
const HISTORY_CAP = 30

export interface SessionHistoryEntry {
  epoch: number
  endedAt: number
  okRatio: number | null
  validMs: number
  activeMs: number
  driftVisits: number
  pagesTotal: number
  nagCount: number
  sCurve: number[] // immersion S resampled to SCURVE_POINTS (may be empty for old entries)
}

export interface ComparisonDelta {
  okRatioDelta: number | null // percentage-point change (current − prior), e.g. +0.12
  validMsDelta: number
  driftVisitsDelta: number
}

export interface SessionComparison {
  sessions: number // prior meaningful sessions compared against
  vsLast: ComparisonDelta | null
  vsAvg: ComparisonDelta | null
  lastSCurve: number[] | null // previous session's S-curve, for the overlay
  avgSCurve: number[] | null // pointwise mean of past S-curves
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function delta(current: SessionHistoryEntry, prior: { okRatio: number | null; validMs: number; driftVisits: number }): ComparisonDelta {
  return {
    okRatioDelta: current.okRatio != null && prior.okRatio != null ? current.okRatio - prior.okRatio : null,
    validMsDelta: current.validMs - prior.validMs,
    driftVisitsDelta: current.driftVisits - prior.driftVisits,
  }
}

/** Pointwise mean of equal-length S-curves; null when none are present. */
function meanCurve(curves: number[][]): number[] | null {
  const valid = curves.filter((c) => c.length > 0)
  if (valid.length === 0) return null
  const n = valid[0].length
  const usable = valid.filter((c) => c.length === n)
  return Array.from({ length: n }, (_, i) => Math.round(mean(usable.map((c) => c[i]))))
}

/** Compare the just-finished session to the previous one and to the rolling average of past
 *  sessions. `history` is the prior sessions (current not yet appended). */
export function computeComparison(
  current: SessionHistoryEntry,
  history: SessionHistoryEntry[],
): SessionComparison {
  const past = history.filter((h) => h.pagesTotal > 0 && h.epoch !== current.epoch)
  if (past.length === 0) {
    return { sessions: 0, vsLast: null, vsAvg: null, lastSCurve: null, avgSCurve: null }
  }
  const last = past[past.length - 1]
  const ratios = past.map((h) => h.okRatio).filter((r): r is number => r != null)
  const avg = {
    okRatio: ratios.length ? mean(ratios) : null,
    validMs: mean(past.map((h) => h.validMs)),
    driftVisits: mean(past.map((h) => h.driftVisits)),
  }
  return {
    sessions: past.length,
    vsLast: delta(current, last),
    vsAvg: delta(current, avg),
    lastSCurve: last.sCurve?.length ? last.sCurve : null,
    avgSCurve: meanCurve(past.map((h) => h.sCurve ?? [])),
  }
}

export async function getSessionHistory(): Promise<SessionHistoryEntry[]> {
  const value = await kvGet<SessionHistoryEntry[]>(HISTORY_KEY)
  return Array.isArray(value) ? value : []
}

/** Append a finished session, keeping the newest HISTORY_CAP. Atomic RMW. */
export async function appendSessionHistory(entry: SessionHistoryEntry): Promise<void> {
  await kvUpdate<SessionHistoryEntry[]>(HISTORY_KEY, (log) =>
    [...(Array.isArray(log) ? log : []), entry].slice(-HISTORY_CAP),
  )
}

export async function clearSessionHistory(): Promise<void> {
  await kvDelete(HISTORY_KEY)
}

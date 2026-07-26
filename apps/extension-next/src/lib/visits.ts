// Per-session visit tracker (P3-8 session summary). Records, per judged page, the total
// attended time and the latest verdict, so the end-of-session summary can show the valid
// page ratio, valid visit time, and longest-dwell page. Pure reducer + durable kv wrappers.
//
// Only judged pages ever get an entry — a page that never passed the 5s sustained-attention
// gate (or a sensitive page, which is never judged) can never accumulate time, so the
// tracker records nothing the observe pipeline wouldn't. Time counts only while the page is
// the attended page AND the browser is present; presence loss closes the open interval.

import type { JudgeVerdict } from "../providers/types.ts"
import { kvDelete, kvGet, kvUpdate } from "./db.ts"

const VISITS_KEY = "session-visits"

// The heartbeat checkpoints (close+reopen) the open interval every minute, so any longer
// gap means a service-worker teardown, system sleep, or browser quit happened mid-interval.
// Count at most this much per interval so those gaps never inflate dwell time.
export const MAX_OPEN_MS = 90_000

// Bound the kv value for very long sessions. Beyond the cap the smallest-ms entry is
// folded into the `evicted` aggregates, keeping the ratio / valid-time totals exact.
export const VISIT_CAP = 300

export interface VisitEntry {
  pageKey: string
  title: string
  host: string
  verdict: JudgeVerdict // latest judge verdict (Tier-1 rescue folded in) or user override
  ms: number // accumulated present-time on this page
  lastSeen: number
}

export interface SessionVisits {
  epoch: number // owning session — a mismatched epoch resets the tracker (defence in depth)
  entries: Record<string, VisitEntry> // keyed by pageKey
  open: { pageKey: string; since: number } | null // the single open interval, durable
  evicted: { pages: number; okPages: number; ms: number; okMs: number }
}

export type VisitAction =
  | { type: "observe"; pageKey: string; ts: number }
  | { type: "judged"; pageKey: string; title: string; host: string; verdict: JudgeVerdict; ts: number }
  | { type: "verdict"; pageKey: string; title: string; host: string; verdict: JudgeVerdict; ts: number }
  | { type: "inactive"; ts: number }
  | { type: "heartbeat"; ts: number }

export function emptyVisits(epoch: number): SessionVisits {
  return { epoch, entries: {}, open: null, evicted: { pages: 0, okPages: 0, ms: 0, okMs: 0 } }
}

/** Close the open interval at `ts`, crediting the elapsed (clamped) time to its entry. */
function closeOpen(v: SessionVisits, ts: number): SessionVisits {
  if (!v.open) return v
  const entry = v.entries[v.open.pageKey]
  if (!entry) return { ...v, open: null }
  const add = Math.max(0, Math.min(ts - v.open.since, MAX_OPEN_MS))
  return {
    ...v,
    entries: { ...v.entries, [entry.pageKey]: { ...entry, ms: entry.ms + add, lastSeen: ts } },
    open: null,
  }
}

/** Fold the smallest-ms non-open entry into the `evicted` aggregates once over the cap. */
function evictOverCap(v: SessionVisits): SessionVisits {
  if (Object.keys(v.entries).length <= VISIT_CAP) return v
  let victim: VisitEntry | null = null
  for (const key of Object.keys(v.entries)) {
    const entry = v.entries[key]
    if (v.open?.pageKey === entry.pageKey) continue
    if (!victim || entry.ms < victim.ms) victim = entry
  }
  if (!victim) return v
  const entries = { ...v.entries }
  delete entries[victim.pageKey]
  const ok = victim.verdict === "OK"
  return {
    ...v,
    entries,
    evicted: {
      pages: v.evicted.pages + 1,
      okPages: v.evicted.okPages + (ok ? 1 : 0),
      ms: v.evicted.ms + victim.ms,
      okMs: v.evicted.okMs + (ok ? victim.ms : 0),
    },
  }
}

export function reduceVisits(
  current: SessionVisits | null | undefined,
  action: VisitAction,
  epoch: number,
): SessionVisits {
  const base =
    current && current.epoch === epoch && current.entries ? current : emptyVisits(epoch)
  switch (action.type) {
    case "observe": {
      // Same page already open: an SPA title-churn storm — nothing to do.
      if (base.open?.pageKey === action.pageKey) return base
      const v = closeOpen(base, action.ts)
      // Reopen ONLY pages that were already judged this session. A never-judged page has no
      // entry, so no interval can open for it until its own judgement lands (which also
      // keeps sensitive pages out — they are never judged).
      if (v.entries[action.pageKey]) return { ...v, open: { pageKey: action.pageKey, since: action.ts } }
      return v
    }
    case "judged":
    case "verdict": {
      const v = closeOpen(base, action.ts)
      const prev = v.entries[action.pageKey]
      const entry: VisitEntry = prev
        ? { ...prev, title: action.title || prev.title, host: action.host || prev.host, verdict: action.verdict, lastSeen: action.ts }
        : { pageKey: action.pageKey, title: action.title, host: action.host, verdict: action.verdict, ms: 0, lastSeen: action.ts }
      return evictOverCap({
        ...v,
        entries: { ...v.entries, [action.pageKey]: entry },
        open: { pageKey: action.pageKey, since: action.ts },
      })
    }
    case "inactive":
      return closeOpen(base, action.ts)
    case "heartbeat": {
      // Durable once-a-minute checkpoint: credit the elapsed time and reopen at `ts`, so a
      // teardown loses at most ~1 minute (and the MAX_OPEN_MS clamp bounds the rest).
      if (!base.open) return base
      const pageKey = base.open.pageKey
      const v = closeOpen(base, action.ts)
      return { ...v, open: { pageKey, since: action.ts } }
    }
  }
}

// --- durable wrappers (best-effort: a lost note only costs summary accuracy) ------

async function note(action: VisitAction, epoch: number): Promise<void> {
  try {
    await kvUpdate<SessionVisits | undefined>(VISITS_KEY, (v) => reduceVisits(v, action, epoch))
  } catch {
    // Tracking is best-effort; the gauge pipeline must never fail because of it.
  }
}

export function noteObserve(pageKey: string, ts: number, epoch: number): Promise<void> {
  return note({ type: "observe", pageKey, ts }, epoch)
}

export function noteJudged(
  pageKey: string,
  title: string,
  host: string,
  verdict: JudgeVerdict,
  ts: number,
  epoch: number,
): Promise<void> {
  return note({ type: "judged", pageKey, title, host, verdict, ts }, epoch)
}

/** User feedback ("목표와 관련 있어요") flips a page's verdict without a re-judge. */
export function noteVerdict(
  pageKey: string,
  title: string,
  host: string,
  verdict: JudgeVerdict,
  ts: number,
  epoch: number,
): Promise<void> {
  return note({ type: "verdict", pageKey, title, host, verdict, ts }, epoch)
}

export function noteInactive(ts: number, epoch: number): Promise<void> {
  return note({ type: "inactive", ts }, epoch)
}

export function noteHeartbeat(ts: number, epoch: number): Promise<void> {
  return note({ type: "heartbeat", ts }, epoch)
}

/** The session's visit entries with the open interval virtually closed at `now` (same clamp
 *  as the reducer), without mutating storage. Shared by the stats + report computations.
 *  Returns [] when the tracker is absent or from another session. */
export function materializeEntries(
  visits: SessionVisits | null,
  epoch: number,
  now: number,
): VisitEntry[] {
  if (!visits || visits.epoch !== epoch) return []
  const open = visits.open
  return Object.values(visits.entries).map((e) =>
    open && e.pageKey === open.pageKey
      ? { ...e, ms: e.ms + Math.max(0, Math.min(now - open.since, MAX_OPEN_MS)) }
      : e,
  )
}

export async function getVisits(): Promise<SessionVisits | null> {
  const value = await kvGet<SessionVisits>(VISITS_KEY)
  return value && typeof value.epoch === "number" && value.entries ? value : null
}

export async function clearVisits(): Promise<void> {
  await kvDelete(VISITS_KEY)
}

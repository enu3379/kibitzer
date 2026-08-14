// The extended session report shown under "세션 더보기" — meaningful flow stats plus playful
// drift stats. Pure and chrome-free (popup + service worker both import it).
//
// Two sources, joined at finalize:
//   • the visit tracker  → accurate present-gated per-host TIME (host bars, MVP, villain)
//   • the event log      → the ordered observe/presence SEQUENCE (streaks, first drift,
//                          recovery, away time, ending) — observe events carry host+verdict.
// The nag log supplies the reaction count, and tick events the lowest gauge value.

import type { JudgeVerdict } from "../providers/types.ts"
import { friendlyHost, friendlyLabel, type FriendlyHost } from "./friendlyHost.ts"
import type { KibitzerEvent } from "./events.ts"
import { extractPresence, type PresencePoint, presentAt } from "./replay.ts"
import { materializeEntries, type SessionVisits } from "./visits.ts"

export interface HostSlice {
  host: string
  label: string // friendly label ("📷 인스타그램" or the bare host)
  friendly: FriendlyHost
  ms: number
  verdict: JudgeVerdict // dominant verdict for this host (OK if any OK time, by ms)
  visits: number // number of times judged into this host (from the observe sequence)
}

export interface SessionReport {
  distinctHosts: number
  avgPageMs: number
  longestFocusMs: number // longest unbroken OK run (approx, by observe spans)
  timeToFirstDriftMs: number | null // start → first DRIFT (null if never drifted)
  awayCount: number
  awayMs: number // genuine away time (may span sleep) — count is shown, this mostly isn't
  nagCount: number
  nagActed: number
  goalMinutes: number | null // declared budget (for the 목표 대비 stat)
  activeMinutes: number // present-gated active time (Σ tracker dwell), the 목표 대비 numerator

  driftVisits: number
  driftMs: number
  topDriftHosts: HostSlice[] // by visit count, top 3
  longestDriftMs: number
  avgDriftEpisodeMs: number | null // 복귀력: mean drift-episode length that returned to OK
  driftClock: "early" | "mid" | "late" | null // when drift concentrated
  secondHalfTrend: "up" | "down" | "flat" | null // OK-ratio 2nd half vs 1st
  ending: JudgeVerdict | null // last judged page's verdict

  lowestS: number | null // lowest gauge value seen (몰입 최저점)

  mvp: { title: string; host: string; ms: number } | null // longest-focused OK page
  villain: HostSlice | null // host with the most drift time
  siteBars: HostSlice[] // top hosts by total time (mixed OK/DRIFT), top 5

  sCurve: number[] // immersion S resampled to SCURVE_POINTS over session progress (0→end)
}

// The immersion S-curve is resampled to a fixed length so this session, the previous one,
// and the rolling average can be overlaid on one time-normalized axis (session progress).
export const SCURVE_POINTS = 24

/** Resample a series to exactly `n` points by linear interpolation over its index range. */
export function resampleSeries(values: number[], n: number): number[] {
  if (values.length === 0) return []
  if (values.length === 1) return Array.from({ length: n }, () => values[0])
  const out: number[] = []
  for (let i = 0; i < n; i += 1) {
    const pos = (i / (n - 1)) * (values.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(values.length - 1, lo + 1)
    const frac = pos - lo
    out.push(Math.round(values[lo] * (1 - frac) + values[hi] * frac))
  }
  return out
}

/** This session's immersion S over its progress, normalized to SCURVE_POINTS. Normalizing by
 *  tick ORDER (session progress), not wall-clock, keeps an overnight-idle session from
 *  squashing the whole curve into a sliver. Empty when the session logged no ticks. */
function sCurveFromEvents(events: KibitzerEvent[], startedAt: number): number[] {
  const ticks = events
    .filter((e) => e.type === "tick" && e.ts >= startedAt && typeof (e.data ?? {}).s === "number")
    .sort((a, b) => a.ts - b.ts)
    .map((e) => (e.data as { s: number }).s)
  return ticks.length ? resampleSeries(ticks, SCURVE_POINTS) : []
}

interface ObserveRow {
  ts: number
  host: string
  verdict: JudgeVerdict
}

/** Pull the ordered (host, verdict) observe sequence for this session out of the event log. */
function observeRows(events: KibitzerEvent[], startedAt: number): ObserveRow[] {
  const rows: ObserveRow[] = []
  for (const e of events) {
    if (e.type !== "observe" || e.ts < startedAt) continue
    const d = e.data ?? {}
    const verdict = d.verdict === "OK" || d.verdict === "DRIFT" ? d.verdict : null
    if (!verdict) continue
    rows.push({ ts: e.ts, host: typeof d.host === "string" ? d.host : "", verdict })
  }
  return rows.sort((a, b) => a.ts - b.ts)
}

/** Away (present:false) count and total ms within the session, from presence transitions. */
function awayStats(events: KibitzerEvent[], startedAt: number, now: number): { count: number; ms: number } {
  const points = events
    .filter((e) => e.type === "presence" && typeof (e.data ?? {}).present === "boolean")
    .map((e) => ({ ts: e.ts, present: Boolean((e.data ?? {}).present) }))
    .filter((p) => p.ts >= startedAt)
    .sort((a, b) => a.ts - b.ts)
  let count = 0
  let ms = 0
  let awaySince: number | null = null
  for (const p of points) {
    if (!p.present && awaySince == null) {
      awaySince = p.ts
      count += 1
    } else if (p.present && awaySince != null) {
      ms += p.ts - awaySince
      awaySince = null
    }
  }
  if (awaySince != null) ms += Math.max(0, now - awaySince) // still away at session end
  return { count, ms }
}

/** Lowest gauge S recorded in tick events this session (null when none). */
function lowestS(events: KibitzerEvent[], startedAt: number): number | null {
  let min: number | null = null
  for (const e of events) {
    if (e.type !== "tick" || e.ts < startedAt) continue
    const s = (e.data ?? {}).s
    if (typeof s === "number" && (min == null || s < min)) min = s
  }
  return min
}

/** Present-gated active time within [a, b] — an idle/away gap (present:false) contributes
 *  ~0, while a legitimately long read (present the whole time) counts in full. This is what
 *  keeps a session left open across a sleep from inflating every duration to hours. */
function activeGap(presence: PresencePoint[], a: number, b: number): number {
  if (b <= a) return 0
  let active = 0
  let cur = a
  let state = presentAt(presence, a)
  for (const p of presence) {
    if (p.ts <= a || p.ts >= b) continue
    if (state) active += p.ts - cur
    cur = p.ts
    state = p.present
  }
  if (state) active += b - cur
  return active
}

/** Per-observe active dwell: present-gated time from each observe to the next (or `now`). */
function activeDwells(rows: ObserveRow[], presence: PresencePoint[], now: number): number[] {
  return rows.map((row, i) => activeGap(presence, row.ts, i + 1 < rows.length ? rows[i + 1].ts : now))
}

/** Longest unbroken run of a verdict, by summed active dwell (idle gaps excluded). */
function longestRunMs(rows: ObserveRow[], dwells: number[], verdict: JudgeVerdict): number {
  let longest = 0
  let run = 0
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].verdict === verdict) {
      run += dwells[i]
      longest = Math.max(longest, run)
    } else {
      run = 0
    }
  }
  return longest
}

/** Mean active length of drift episodes that returned to OK (복귀력). A trailing drift run
 *  that never returned to OK is excluded (there's no recovery time to average). */
function avgDriftEpisodeMs(rows: ObserveRow[], dwells: number[]): number | null {
  const episodes: number[] = []
  let run = 0
  let inDrift = false
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].verdict === "DRIFT") {
      run += dwells[i]
      inDrift = true
    } else {
      if (inDrift) episodes.push(run)
      run = 0
      inDrift = false
    }
  }
  if (episodes.length === 0) return null
  return Math.round(episodes.reduce((a, b) => a + b, 0) / episodes.length)
}

/** Which third of the session drift concentrated in (by drift-observe count). */
function driftClock(rows: ObserveRow[], startedAt: number, now: number): "early" | "mid" | "late" | null {
  const span = now - startedAt
  if (span <= 0) return null
  const buckets = [0, 0, 0]
  let any = false
  for (const row of rows) {
    if (row.verdict !== "DRIFT") continue
    any = true
    const third = Math.min(2, Math.floor(((row.ts - startedAt) / span) * 3))
    buckets[Math.max(0, third)] += 1
  }
  if (!any) return null
  const max = Math.max(...buckets)
  return buckets[0] === max ? "early" : buckets[1] === max ? "mid" : "late"
}

/** OK-ratio in the 2nd half vs the 1st half of the observe sequence. */
function secondHalfTrend(rows: ObserveRow[]): "up" | "down" | "flat" | null {
  if (rows.length < 4) return null
  const mid = Math.floor(rows.length / 2)
  const okRatio = (slice: ObserveRow[]): number =>
    slice.length ? slice.filter((r) => r.verdict === "OK").length / slice.length : 0
  const first = okRatio(rows.slice(0, mid))
  const second = okRatio(rows.slice(mid))
  const delta = second - first
  return delta > 0.1 ? "up" : delta < -0.1 ? "down" : "flat"
}

export function computeReport(
  visits: SessionVisits | null,
  events: KibitzerEvent[],
  nag: { count: number; acted: number },
  goal: { startedAt: number; availableMinutes: number | null; epoch: number },
  now: number,
): SessionReport {
  const entries = materializeEntries(visits, goal.epoch, now)
  const rows = observeRows(events, goal.startedAt)
  const presence = extractPresence(events).filter((p) => p.ts >= goal.startedAt)
  const dwells = activeDwells(rows, presence, now)

  // Per-host time aggregation (accurate, present-gated) from the tracker.
  const hostMs = new Map<string, { ms: number; okMs: number; driftMs: number }>()
  for (const e of entries) {
    const slot = hostMs.get(e.host) ?? { ms: 0, okMs: 0, driftMs: 0 }
    slot.ms += e.ms
    if (e.verdict === "OK") slot.okMs += e.ms
    else slot.driftMs += e.ms
    hostMs.set(e.host, slot)
  }
  // Per-host visit counts (how many times judged into it) from the observe sequence.
  const hostVisits = new Map<string, number>()
  for (const row of rows) hostVisits.set(row.host, (hostVisits.get(row.host) ?? 0) + 1)

  const sliceOf = (host: string, ms: number, verdict: JudgeVerdict): HostSlice => ({
    host,
    label: friendlyLabel(host),
    friendly: friendlyHost(host),
    ms,
    verdict,
    visits: hostVisits.get(host) ?? 0,
  })

  const siteBars: HostSlice[] = [...hostMs.entries()]
    .map(([host, s]) => sliceOf(host, s.ms, s.driftMs > s.okMs ? "DRIFT" : "OK"))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)

  // Villain: the host with the most DRIFT time.
  let villain: HostSlice | null = null
  for (const [host, s] of hostMs) {
    if (s.driftMs > 0 && (!villain || s.driftMs > villain.ms)) villain = sliceOf(host, s.driftMs, "DRIFT")
  }

  // MVP: the single OK page with the most focus time.
  let mvp: { title: string; host: string; ms: number } | null = null
  for (const e of entries) {
    if (e.verdict === "OK" && (!mvp || e.ms > mvp.ms)) mvp = { title: e.title, host: e.host, ms: e.ms }
  }

  // Top drift hosts by visit count (the "인스타 5번" leaderboard).
  const driftHostAgg = new Map<string, { ms: number; visits: number }>()
  for (const row of rows) {
    if (row.verdict !== "DRIFT") continue
    const slot = driftHostAgg.get(row.host) ?? { ms: 0, visits: 0 }
    slot.visits += 1
    slot.ms = hostMs.get(row.host)?.driftMs ?? slot.ms
    driftHostAgg.set(row.host, slot)
  }
  const topDriftHosts: HostSlice[] = [...driftHostAgg.entries()]
    .map(([host, s]) => sliceOf(host, s.ms, "DRIFT"))
    .sort((a, b) => b.visits - a.visits || b.ms - a.ms)
    .slice(0, 3)

  const driftVisits = rows.filter((r) => r.verdict === "DRIFT").length
  const driftMs = [...hostMs.values()].reduce((sum, s) => sum + s.driftMs, 0)
  const firstDrift = rows.find((r) => r.verdict === "DRIFT")
  const totalMs = entries.reduce((sum, e) => sum + e.ms, 0)
  const away = awayStats(events, goal.startedAt, now)

  return {
    distinctHosts: hostMs.size,
    avgPageMs: entries.length ? Math.round(totalMs / entries.length) : 0,
    longestFocusMs: longestRunMs(rows, dwells, "OK"),
    // Active time before the first drift — idle gaps excluded, so it's "how long you stayed
    // on-goal", not wall-clock to the first wander.
    timeToFirstDriftMs: firstDrift ? activeGap(presence, goal.startedAt, firstDrift.ts) : null,
    awayCount: away.count,
    awayMs: away.ms,
    nagCount: nag.count,
    nagActed: nag.acted,
    goalMinutes: goal.availableMinutes,
    activeMinutes: Math.max(1, Math.round(totalMs / 60_000)),

    driftVisits,
    driftMs,
    topDriftHosts,
    longestDriftMs: longestRunMs(rows, dwells, "DRIFT"),
    avgDriftEpisodeMs: avgDriftEpisodeMs(rows, dwells),
    driftClock: driftClock(rows, goal.startedAt, now),
    secondHalfTrend: secondHalfTrend(rows),
    ending: rows.length ? rows[rows.length - 1].verdict : null,

    lowestS: lowestS(events, goal.startedAt),

    mvp,
    villain,
    siteBars,
    sCurve: sCurveFromEvents(events, goal.startedAt),
  }
}

// Session summary statistics — pure and chrome-free, so both the service worker (compute)
// and the popup bundle (formatting / meter bands) can import it.

import type { JudgeVerdict } from "../providers/types.ts"
import { materializeEntries, type SessionVisits } from "./visits.ts"

export interface SessionTopPage {
  title: string
  host: string
  ms: number
  verdict: JudgeVerdict
}

export interface SessionStats {
  goalText: string
  // Wall-clock span (start → end). NOT the summary denominator: a goal left open across a
  // sleep/overnight would make this huge, so display + ratios use activeMs instead.
  sessionMinutes: number
  // Total present-gated time spent on judged pages (Σ tracker dwell, clamped per interval).
  // This is the meaningful "how long you were actually browsing" figure and the denominator
  // for the valid-time ratio and 목표 대비.
  activeMs: number
  pagesTotal: number // judged pages (5s sustained-attention gate), evicted included
  pagesOk: number
  okRatio: number | null // null when no page was judged
  validMs: number // present-time accumulated on OK pages
  nagCount: number
  topPage: SessionTopPage | null
  topPages: SessionTopPage[] // top 5 by dwell, for the Tier-2 recap payload
  endedAt: number
}

export function computeSessionStats(
  visits: SessionVisits | null,
  goal: { text: string; startedAt: number; epoch: number },
  nagCount: number,
  now: number,
): SessionStats {
  const usable = visits && visits.epoch === goal.epoch ? visits : null
  // Virtually close the open interval at `now` — the summary must include the page the user
  // is leaving right now.
  const entries = materializeEntries(visits, goal.epoch, now)
  const evicted = usable?.evicted ?? { pages: 0, okPages: 0, ms: 0, okMs: 0 }
  const pagesTotal = entries.length + evicted.pages
  const pagesOk = entries.filter((e) => e.verdict === "OK").length + evicted.okPages
  const validMs =
    entries.filter((e) => e.verdict === "OK").reduce((sum, e) => sum + e.ms, 0) + evicted.okMs
  const activeMs = entries.reduce((sum, e) => sum + e.ms, 0) + evicted.ms
  const byMs = [...entries].sort((a, b) => b.ms - a.ms)
  const toTop = (e: (typeof entries)[number]): SessionTopPage => ({
    title: e.title,
    host: e.host,
    ms: e.ms,
    verdict: e.verdict,
  })
  return {
    goalText: goal.text,
    sessionMinutes: Math.max(1, Math.round((now - goal.startedAt) / 60_000)),
    activeMs,
    pagesTotal,
    pagesOk,
    okRatio: pagesTotal > 0 ? pagesOk / pagesTotal : null,
    validMs,
    nagCount,
    topPage: byMs.length > 0 ? toTop(byMs[0]) : null,
    topPages: byMs.slice(0, 5).map(toTop),
    endedAt: now,
  }
}

// --- special sessions (⑤ event lines) --------------------------------------------

export type SpecialEvent = "perfect" | "all_drift" | "no_nag"

/** Rare sessions that deserve a dedicated remark. Precedence: perfect > all_drift > no_nag. */
export function detectSpecial(stats: SessionStats): SpecialEvent | null {
  if (stats.pagesTotal === 0) return null
  if (stats.pagesOk === stats.pagesTotal) return "perfect"
  if (stats.pagesOk === 0) return "all_drift"
  if (stats.nagCount === 0) return "no_nag"
  return null
}

// --- presentation helpers (shared with the popup) --------------------------------

/** Korean duration: "1분 미만" / "45분" / "1시간" / "1시간 23분". */
export function formatDurationKo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "1분 미만"
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}분`
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`
}

/** Meter band for a 0–100 percentage — the gauge's severity bands (D: popup redesign). */
export function bandOf(pct: number): "ok" | "warn" | "bad" {
  return pct >= 66 ? "ok" : pct >= 33 ? "warn" : "bad"
}

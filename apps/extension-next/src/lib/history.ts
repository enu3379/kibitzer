// Visit + nag history for the Tier-2 persona context. Mirrors the server's
// nagging_context (apps/server/app/api/observations.py::_nagging_context) and the
// review payload's recent_titles, so the personas can say "오늘 세 번째군요" /
// "또 그 자리네요" / fold in drift duration and whether the last nudge was ignored.
//
// Both logs live in the IndexedDB SSOT (lib/db.ts) so recent-visit context and
// nag_count_today survive a browser restart, not just a service-worker teardown.

import type { RecentTitle } from "../providers/payloads.ts"
import { kvDelete, kvGet, kvSet } from "./db.ts"

const OBS_KEY = "recent-obs"
const NAG_LOG_KEY = "nag-log"
const OBS_CAP = 20
const NAG_CAP = 40

export interface ObsEntry {
  title: string
  urlHost: string
  verdict: string
  ts: number
}

interface NagEntry {
  ts: number
  host: string
  token: number
  acted: boolean
}

function localMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// --- observations (review payload recent_titles) ---------------------------------

async function readObs(): Promise<ObsEntry[]> {
  const value = await kvGet<ObsEntry[]>(OBS_KEY)
  return Array.isArray(value) ? value : []
}

/** Append the just-judged page. Consecutive duplicates of the same page are collapsed
 *  so a SPA update storm doesn't flood the recent-titles window. */
export async function recordObservation(entry: ObsEntry): Promise<void> {
  const log = await readObs()
  const last = log.at(-1)
  if (last && last.title === entry.title && last.urlHost === entry.urlHost && last.verdict === entry.verdict) {
    return
  }
  log.push(entry)
  await kvSet(OBS_KEY, log.slice(-OBS_CAP))
}

/** Recent {title, verdict} in chronological order — feeds recent_titles / repeat_signals. */
export async function recentTitles(): Promise<RecentTitle[]> {
  return (await readObs()).map((o) => ({ title: o.title, verdict: o.verdict }))
}

// --- nags (nagging_context) ------------------------------------------------------

async function readNags(): Promise<NagEntry[]> {
  const value = await kvGet<NagEntry[]>(NAG_LOG_KEY)
  return Array.isArray(value) ? value : []
}

/** Log a delivered nag so the next one knows the count, host, and (later) whether this
 *  one was acted on. `token` is the toast displayToken, matched by feedback. */
export async function recordNag(entry: { ts: number; host: string; token: number }): Promise<void> {
  const log = await readNags()
  log.push({ ...entry, acted: false })
  await kvSet(NAG_LOG_KEY, log.slice(-NAG_CAP))
}

/** Mark a nag as acted on (user gave explicit feedback other than letting it time out). */
export async function markNagActed(token: number): Promise<void> {
  const log = await readNags()
  const entry = log.find((n) => n.token === token)
  if (!entry || entry.acted) return
  entry.acted = true
  await kvSet(NAG_LOG_KEY, log)
}

/** Nags delivered since local midnight, BEFORE the one about to fire (matches server). */
export async function nagCountToday(now: number): Promise<number> {
  const midnight = localMidnight(now)
  return (await readNags()).filter((n) => n.ts >= midnight).length
}

/** True when the previous nag drew no explicit response (server's last_nag_ignored). */
export async function lastNagIgnored(): Promise<boolean> {
  const last = (await readNags()).at(-1)
  return Boolean(last && !last.acted)
}

/** True when the last nag fired on this same host — they came back to the same site. */
export async function repeatHost(currentHost: string): Promise<boolean> {
  const last = (await readNags()).at(-1)
  return Boolean(currentHost && last?.host && last.host === currentHost)
}

/** Clear both logs — called when the goal changes (a fresh context). */
export async function clearHistory(): Promise<void> {
  await kvDelete(OBS_KEY)
  await kvDelete(NAG_LOG_KEY)
}

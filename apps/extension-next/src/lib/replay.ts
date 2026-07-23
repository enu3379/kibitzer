// Offline replay / counterfactual tuning — the serverless analog of the server's
// replay_session. It re-runs a recorded session (the structured event log, P2-2) under a
// different tau_ok, using the vendored pure logic (relevance threshold + reduceGauge), so
// "what if the threshold were X" can be answered from data instead of live trial-and-error.
//
// Everything here is pure and testable; the replay page feeds it events from IndexedDB or
// an imported JSONL file. No server, no DB connection.

import { reduceGauge } from "../core/gauge/reducer.ts"
import { defaultGaugeConfig } from "../core/gauge/config.ts"
import { initGaugeState } from "../core/gauge/types.ts"
import type { GaugeState } from "../core/gauge/types.ts"
import type { KibitzerEvent } from "./events.ts"

export interface ObserveRecord {
  ts: number
  pageKey: string
  score: number // recorded Tier-0 max-cosine
  tier0: string // recorded Tier-0 verdict at capture time
}

/** Pull the Tier-0 observations (with a numeric score) out of the raw event log. */
export function extractObserves(events: KibitzerEvent[]): ObserveRecord[] {
  const out: ObserveRecord[] = []
  for (const e of events) {
    if (e.type !== "observe") continue
    const d = e.data ?? {}
    if (typeof d.score !== "number") continue
    out.push({
      ts: e.ts,
      pageKey: typeof d.pageKey === "string" ? d.pageKey : "",
      score: d.score,
      tier0: typeof d.tier0 === "string" ? d.tier0 : "",
    })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export interface TauPoint {
  tau: number
  ok: number
  drift: number
  flips: number // observations whose Tier-0 verdict differs from the recorded one
}

/** For each candidate tau_ok, re-threshold every observation's recorded score. */
export function tauSweep(observes: ObserveRecord[], taus: number[]): TauPoint[] {
  return taus.map((tau) => {
    let ok = 0
    let drift = 0
    let flips = 0
    for (const o of observes) {
      const verdict = o.score >= tau ? "OK" : "DRIFT"
      if (verdict === "OK") ok += 1
      else drift += 1
      if (o.tier0 && verdict !== o.tier0) flips += 1
    }
    return { tau, ok, drift, flips }
  })
}

export interface GaugeReplay {
  nagCount: number
  nagTimes: number[]
  series: Array<{ ts: number; s: number }>
}

const HEARTBEAT_MS = 60_000
const MAX_HEARTBEATS_PER_GAP = 60 // cap a single gap at ~1h of assumed presence

/** Re-run the gauge over the recorded observations at a given tau_ok, in degraded mode so
 *  nags fire from the embedding verdict alone (no LLM needed). Heartbeats are synthesized
 *  between observations to reconstruct the drain/recovery — this assumes the user was
 *  present during each gap (long gaps are treated as inactive), an approximation. */
export function replayGauge(
  observes: ObserveRecord[],
  tauOk: number,
  availableMinutes: number | null = null,
): GaugeReplay {
  const config = defaultGaugeConfig(availableMinutes)
  let state: GaugeState = initGaugeState()
  const series: Array<{ ts: number; s: number }> = []
  const nagTimes: number[] = []

  const step = (event: Parameters<typeof reduceGauge>[1]): void => {
    const t = reduceGauge(state, event, config)
    state = t.state
    for (const eff of t.effects) if (eff.type === "nag") nagTimes.push(event.ts)
  }

  let lastTs: number | null = null
  for (const o of observes) {
    if (lastTs != null) {
      const gap = o.ts - lastTs
      const beats = Math.floor(gap / HEARTBEAT_MS)
      if (beats > MAX_HEARTBEATS_PER_GAP) {
        step({ type: "inactive", ts: o.ts - 1 }) // long idle: rebase, don't integrate
      } else {
        for (let b = 1; b <= beats; b += 1) {
          step({ type: "heartbeat", ts: lastTs + b * HEARTBEAT_MS })
          series.push({ ts: state.updatedAt, s: state.s })
        }
      }
    }
    const verdict = o.score >= tauOk ? "OK" : "DRIFT"
    step({ type: "nav", pageKey: o.pageKey, verdict, r0: o.score, tauOk, degraded: true, ts: o.ts })
    series.push({ ts: o.ts, s: state.s })
    lastTs = o.ts
  }
  return { nagCount: nagTimes.length, nagTimes, series }
}

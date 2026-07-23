// Kibitzer (next) — serverless MV3 service worker (skeleton).
//
// Target pipeline (authoritative, no server):
//   Chrome nav → TS Tier 0 (WasmEmbeddingProvider) → TS Tier 1/2 (OllamaChatJudgeProvider)
//   → gauge (reduceGauge, real trigger) → chrome.notifications.
//
// This first cut only wires the gauge core + event surface. The provider calls, the
// IndexedDB SSOT (adapted from apps/extension's gaugeIndexedDb), effect delivery, and
// the popup are follow-up PRs — marked TODO(pipeline) below. Nothing here delivers a
// real nag yet.

import { reduceGauge } from "./core/gauge/reducer.ts"
import { defaultGaugeConfig } from "./core/gauge/config.ts"
import { initGaugeState } from "./core/gauge/types.ts"
import type { GaugeConfig, GaugeEffect, GaugeEvent, GaugeState } from "./core/gauge/types.ts"

const HEARTBEAT_ALARM = "kibitzer-next-heartbeat"

// In-memory gauge state for now; the IndexedDB SSOT + outbox replaces this next.
let gaugeState: GaugeState = initGaugeState()
const gaugeConfig: GaugeConfig = defaultGaugeConfig(null)

/** Advance the gauge with one event and surface its effect intents. */
function dispatchGauge(event: GaugeEvent): GaugeEffect[] {
  const transition = reduceGauge(gaugeState, event, gaugeConfig)
  gaugeState = transition.state
  // TODO(pipeline): deliver nag/celebrate effects via chrome.notifications + offscreen audio.
  return transition.effects
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 })
})

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return
  // TODO(pipeline): embed (Tier 0 WASM) → judge (Tier 1/2 Ollama) → produce a verdict,
  // then dispatchGauge({ type: "nav", pageKey, verdict, ts: details.timeStamp }).
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return
  // TODO(pipeline): dispatchGauge({ type: "heartbeat", ts: Date.now() }) while a tab is active.
})

// Keep the skeleton's single side-effecting entry referenced so the bundle is meaningful.
export { dispatchGauge }

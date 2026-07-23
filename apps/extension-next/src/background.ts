// Kibitzer (next) — serverless MV3 service worker.
//
// Authoritative pipeline (Tier-0-only first slice; the Ollama Tier 1/2 layer and the
// IndexedDB SSOT are follow-up PRs):
//   page settles / tab activates → embed title vs goal (Tier 0 WASM) → verdict
//   → gauge (degraded mode) → S drains on drift → S=0 → real nag notification.
// A 1-min alarm feeds heartbeats so dwell time (not click count) drives the gauge.

import { getGoal, setGoal, type SessionGoal } from "./lib/session.ts"
import { judgeTier0, TAU_OK } from "./lib/tier0.ts"
import { currentState, dispatch, resetState } from "./lib/gaugeRuntime.ts"

const HEARTBEAT_ALARM = "kibitzer-next-heartbeat"

function pageKeyOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return null
  }
}

/** Embed the page title vs the goal and feed the verdict into the gauge as a nav event. */
async function observe(url: string | undefined, title: string | undefined): Promise<void> {
  const goal = await getGoal()
  if (!goal || !url || !title) return
  const pageKey = pageKeyOf(url)
  if (!pageKey) return
  const { score, verdict } = await judgeTier0(goal.text, title, TAU_OK)
  await dispatch(
    { type: "nav", pageKey, verdict, r0: score, tauOk: TAU_OK, degraded: true, ts: Date.now() },
    goal,
  )
}

async function observeActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab) await observe(tab.url, tab.title)
}

function ensureHeartbeat(): void {
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 })
}

// --- observation surface ---------------------------------------------------------

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return
  void observe(tab.url, tab.title)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(
    (tab) => observe(tab.url, tab.title),
    () => undefined,
  )
})

// --- heartbeat / presence --------------------------------------------------------

chrome.runtime.onInstalled.addListener(ensureHeartbeat)
chrome.runtime.onStartup.addListener(ensureHeartbeat)

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return
  void getGoal().then((goal) => {
    if (goal) return dispatch({ type: "heartbeat", ts: Date.now() }, goal)
    return undefined
  })
})

chrome.idle.setDetectionInterval(60)
chrome.idle.onStateChanged.addListener((state) => {
  void getGoal().then((goal) => {
    if (!goal) return undefined
    if (state === "active") return observeActiveTab()
    return dispatch({ type: "inactive", ts: Date.now() }, goal)
  })
})

// --- popup messaging -------------------------------------------------------------

interface PopupMessage {
  type?: string
  goal?: string
  minutes?: number | null
}

async function handleMessage(message: PopupMessage): Promise<unknown> {
  if (message?.type === "get-state") {
    const [goal, state] = await Promise.all([getGoal(), currentState()])
    return { goal, s: Math.round(state.s), accelTier: state.accelTier }
  }
  if (message?.type === "set-goal") {
    const goal: SessionGoal | null = await setGoal(
      message.goal ?? "",
      typeof message.minutes === "number" ? message.minutes : null,
    )
    await resetState()
    ensureHeartbeat()
    if (goal) void observeActiveTab()
    return { goal }
  }
  return { error: "unknown message" }
}

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

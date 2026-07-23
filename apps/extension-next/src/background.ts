// Kibitzer (next) — serverless MV3 service worker.
//
// Authoritative pipeline (Tier-0-only first slice; the Ollama Tier 1/2 layer and the
// IndexedDB SSOT are follow-up PRs):
//   page settles / tab activates → embed title vs goal (Tier 0 WASM) → verdict
//   → gauge (degraded mode) → S drains on drift → S=0 → real nag notification.
// A 1-min alarm feeds heartbeats so dwell time (not click count) drives the gauge.

import { getGoal, setGoal, type SessionGoal } from "./lib/session.ts"
import { judgeTier0, TAU_OK } from "./lib/tier0.ts"
import { currentState, dispatch, resetState, setActivePage, testNag } from "./lib/gaugeRuntime.ts"
import { getOllamaConfig, ollamaEnabled, setOllamaConfig, testOllama, tier1Rescue } from "./lib/tier12.ts"
import { getPersonaKey, personaChoices, setPersonaKey } from "./lib/personas.ts"

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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

let lastObservedKey: string | null = null

/** Embed the page title vs the goal (Tier 0), optionally rescue via Tier 1 (Ollama),
 *  and feed the verdict into the gauge. Normal mode when Ollama is on; else degraded.
 *  Debounced per page so SPA update storms (e.g. YouTube) don't re-judge the same page
 *  and keep clearing the Tier 2 verdict override — that was the S 0↔30 yo-yo. */
async function observe(url: string | undefined, title: string | undefined): Promise<void> {
  const goal = await getGoal()
  if (!goal || !url || !title) return
  const pageKey = pageKeyOf(url)
  if (!pageKey || pageKey === lastObservedKey) return
  lastObservedKey = pageKey
  const urlHost = hostOf(url)
  const { score, verdict: tier0Verdict } = await judgeTier0(goal.text, title, TAU_OK)
  const enabled = await ollamaEnabled()
  let verdict = tier0Verdict
  if (verdict === "DRIFT" && enabled) {
    verdict = await tier1Rescue(goal.text, title, urlHost) // Tier 1 may rescue to OK
  }
  console.log(`[kbz] observe ${pageKey} tier0=${tier0Verdict}(${score.toFixed(2)}) final=${verdict}`)
  await setActivePage({ pageKey, title, urlHost, score })
  await dispatch(
    { type: "nav", pageKey, verdict, r0: score, tauOk: TAU_OK, degraded: !enabled, ts: Date.now() },
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
  kind?: string
  apiUrl?: string
  apiKeys?: string[]
  tier1Model?: string
  tier2Model?: string
  persona?: string
}

async function handleMessage(message: PopupMessage): Promise<unknown> {
  if (message?.type === "get-state") {
    const goal = await getGoal()
    // Advance the gauge to "now" so the popup shows a live value between the
    // 1-min heartbeat alarms (a nag can still fire here if S reaches 0).
    if (goal) await dispatch({ type: "heartbeat", ts: Date.now() }, goal)
    const [state, ollama, persona] = await Promise.all([
      currentState(),
      getOllamaConfig(),
      getPersonaKey(),
    ])
    return {
      goal,
      s: Math.round(state.s),
      accelTier: state.accelTier,
      ollama,
      persona,
      personas: personaChoices(),
    }
  }
  if (message?.type === "set-persona") {
    return { persona: await setPersonaKey(message.persona ?? "") }
  }
  if (message?.type === "test-ollama") {
    return await testOllama({
      apiUrl: message.apiUrl,
      apiKeys: message.apiKeys,
      tier1Model: message.tier1Model,
      tier2Model: message.tier2Model,
    })
  }
  if (message?.type === "set-ollama") {
    const ollama = await setOllamaConfig({
      apiUrl: message.apiUrl,
      apiKeys: message.apiKeys,
      tier1Model: message.tier1Model,
      tier2Model: message.tier2Model,
    })
    return { ollama }
  }
  if (message?.type === "set-goal") {
    const previous = await getGoal()
    const goal: SessionGoal | null = await setGoal(
      message.goal ?? "",
      typeof message.minutes === "number" ? message.minutes : null,
    )
    // Only restart the gauge when the goal actually changes (or is cleared).
    if (!goal || previous?.text !== goal.text) await resetState()
    ensureHeartbeat()
    if (goal) {
      lastObservedKey = null // re-judge the active page under the new goal
      // Test shortcut: goal "알림보기" fires a nag notification right away.
      if (goal.text === "알림보기") await testNag(goal)
      void observeActiveTab()
    }
    return { goal }
  }
  if (message?.type === "kibitzer:toast-feedback") {
    const goal = await getGoal()
    if (goal) {
      const now = Date.now()
      // "5분만" / "30분 조용히" quiet the gauge; other feedback just dismisses the toast.
      if (message.kind === "break") await dispatch({ type: "snooze", until: now + 5 * 60_000, ts: now }, goal)
      else if (message.kind === "snooze") await dispatch({ type: "snooze", until: now + 30 * 60_000, ts: now }, goal)
    }
    return { ok: true }
  }
  return { error: "unknown message" }
}

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

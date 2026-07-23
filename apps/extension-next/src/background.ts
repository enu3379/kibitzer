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
import { getProviderHealth } from "./lib/providerHealth.ts"
import { clearBadge } from "./lib/badge.ts"
import { clearEvents, exportEvents, logEvent } from "./lib/events.ts"
import { markNagActed, recordObservation } from "./lib/history.ts"
import { clearLog, exportLog, klog, logText } from "./lib/klog.ts"
import { shouldDropUrl } from "./lib/domainFilter.ts"
import { hostOf, pageKeyOf } from "./lib/url.ts"

const HEARTBEAT_ALARM = "kibitzer-next-heartbeat"

let lastObservedKey: string | null = null

// A page is judged only after it has been dwelt on for OBSERVE_DWELL_MS of sustained
// attention — a quick glance / bounce never counts, embeds, or pollutes recent-titles.
// (Sensitive pages are handled immediately, without waiting.)
const OBSERVE_DWELL_MS = 5000
let dwellTimer: ReturnType<typeof setTimeout> | null = null
let pendingObsKey: string | null = null

function cancelDwell(): void {
  if (dwellTimer) {
    clearTimeout(dwellTimer)
    dwellTimer = null
  }
}

/** Entry for every observation trigger (nav / activate / SPA). Debounces per page, pauses
 *  immediately on sensitive pages, and otherwise schedules the judgement after a dwell so
 *  transient pages don't count. */
async function observe(url: string | undefined, title: string | undefined): Promise<void> {
  const goal = await getGoal()
  if (!goal || !url || !title) return
  const pageKey = pageKeyOf(url)
  if (!pageKey) return
  // Debounce on pageKey+title, not pageKey alone: an SPA route change that keeps the
  // path but swaps the title (YouTube video → video) still re-judges, while an update
  // storm on the identical page is collapsed (the old S 0↔30 yo-yo guard).
  const obsKey = `${pageKey}\n${title}`
  if (obsKey === lastObservedKey) return
  // A new candidate page cancels the previous page's pending dwell (it never counted).
  cancelDwell()
  pendingObsKey = obsKey
  // Privacy gate: sensitive pages pause the gauge immediately — no dwell, no judging.
  if (shouldDropUrl(url)) {
    lastObservedKey = obsKey
    klog(`drop (sensitive) ${pageKey}`)
    await dispatch({ type: "inactive", ts: Date.now() }, goal)
    return
  }
  dwellTimer = setTimeout(() => {
    dwellTimer = null
    void judgeAndDispatch(url, title, obsKey)
  }, OBSERVE_DWELL_MS)
}

/** Embed title vs goal (Tier 0), optionally rescue via Tier 1 (Ollama), and feed the
 *  verdict into the gauge — after the dwell, and only if the page is still the candidate. */
async function judgeAndDispatch(url: string, title: string, obsKey: string): Promise<void> {
  if (pendingObsKey !== obsKey) return // navigated away during the dwell
  const goal = await getGoal()
  if (!goal) return
  const pageKey = pageKeyOf(url)
  if (!pageKey) return
  lastObservedKey = obsKey
  const urlHost = hostOf(url)
  const { score, verdict: tier0Verdict } = await judgeTier0(goal.text, title, TAU_OK)
  const enabled = await ollamaEnabled()
  let verdict = tier0Verdict
  if (verdict === "DRIFT" && enabled) {
    verdict = await tier1Rescue(goal.text, title, urlHost) // Tier 1 may rescue to OK
  }
  klog(`observe ${pageKey} tier0=${tier0Verdict}(${score.toFixed(2)}) final=${verdict} mode=${enabled ? "ollama" : "degraded"}`)
  logEvent("observe", { pageKey, host: urlHost, tier0: tier0Verdict, score: Number(score.toFixed(3)), verdict, mode: enabled ? "ollama" : "degraded" })
  const now = Date.now()
  await setActivePage({ pageKey, title, urlHost, score })
  await recordObservation({ title, urlHost, verdict, ts: now }) // recent_titles / repeat context
  await dispatch(
    { type: "nav", pageKey, verdict, r0: score, tauOk: TAU_OK, degraded: !enabled, ts: now },
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

/** True only when a Chrome window has OS focus AND the user is active. chrome.idle is
 *  system-wide (idle stays "active" while the user works in another app), so the gauge
 *  must also require Chrome to be the focused window — otherwise S drains and nags fire
 *  while Chrome is off-screen. Unknown → assume present (never over-suppress). */
async function browserPresent(): Promise<boolean> {
  try {
    const win = await chrome.windows.getLastFocused()
    if (!win.focused) return false
    return (await chrome.idle.queryState(60)) === "active"
  } catch {
    return true
  }
}

// --- observation surface ---------------------------------------------------------

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Fire on page-load completion AND on title changes — SPAs (YouTube, etc.) swap the
  // title without a fresh "complete", and that's how their route changes surface here.
  if (!tab.active) return
  if (changeInfo.status === "complete" || changeInfo.title !== undefined) {
    void observe(tab.url, tab.title)
  }
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(
    (tab) => observe(tab.url, tab.title),
    () => undefined,
  )
})

// SPA in-page navigation (history.pushState) — no "complete" event fires, so observe the
// top frame directly. tabs.onUpdated(title) catches the rest.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return
  void chrome.tabs.get(details.tabId).then(
    (tab) => (tab.active ? observe(tab.url ?? details.url, tab.title) : undefined),
    () => undefined,
  )
})

// --- heartbeat / presence --------------------------------------------------------

chrome.runtime.onInstalled.addListener(ensureHeartbeat)
chrome.runtime.onStartup.addListener(ensureHeartbeat)

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return
  void getGoal().then(async (goal) => {
    if (!goal) return
    // Only drain while Chrome is focused and the user is active; otherwise pause.
    const present = await browserPresent()
    await dispatch({ type: present ? "heartbeat" : "inactive", ts: Date.now() }, goal)
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

// Chrome losing OS focus (user switched to another app) pauses the gauge; regaining it
// re-observes the active tab. Complements the system-wide idle signal above.
chrome.windows.onFocusChanged.addListener((windowId) => {
  void getGoal().then((goal) => {
    if (!goal) return undefined
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      return dispatch({ type: "inactive", ts: Date.now() }, goal)
    }
    return observeActiveTab()
  })
})

// Feedback from the OS-notification fallback (buttons: 0=related, 1=break), routed
// through the same handler as the in-page toast.
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith("kbz-")) return
  void handleMessage({ type: "kibitzer:toast-feedback", kind: buttonIndex === 0 ? "related" : "break" })
  void chrome.notifications.clear(notificationId)
})
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("kbz-")) void chrome.notifications.clear(notificationId)
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
  displayToken?: number
}

async function handleMessage(message: PopupMessage): Promise<unknown> {
  if (message?.type === "get-state") {
    const goal = await getGoal()
    // Advance the gauge to "now" so the popup shows a live value between the
    // 1-min heartbeat alarms (a nag can still fire here if S reaches 0).
    if (goal) await dispatch({ type: "heartbeat", ts: Date.now() }, goal)
    const [state, ollama, persona, health] = await Promise.all([
      currentState(),
      getOllamaConfig(),
      getPersonaKey(),
      getProviderHealth(),
    ])
    return {
      goal,
      s: Math.round(state.s),
      accelTier: state.accelTier,
      ollama,
      persona,
      personas: personaChoices(),
      health,
    }
  }
  if (message?.type === "set-persona") {
    return { persona: await setPersonaKey(message.persona ?? "") }
  }
  if (message?.type === "get-log") {
    return { text: await logText() }
  }
  if (message?.type === "export-log") {
    return await exportLog()
  }
  if (message?.type === "clear-log") {
    await clearLog()
    return { ok: true }
  }
  if (message?.type === "export-events") {
    return await exportEvents()
  }
  if (message?.type === "clear-events") {
    await clearEvents()
    return { ok: true }
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
    // Restart the gauge when the goal actually changes (text OR minutes → new revision)
    // or is cleared.
    if (!goal || previous?.revision !== goal.revision) await resetState()
    logEvent("goal", { text: goal?.text ?? null, minutes: goal?.availableMinutes ?? null, revision: goal?.revision ?? null })
    ensureHeartbeat()
    if (goal) {
      lastObservedKey = null // re-judge the active page under the new goal
      // Test shortcut: goal "알림보기" fires a nag notification right away.
      if (goal.text === "알림보기") await testNag(goal)
      void observeActiveTab()
    } else {
      clearBadge() // goal cleared → no status to show
    }
    return { goal }
  }
  if (message?.type === "kibitzer:toast-feedback") {
    // Any explicit response (not a silent timeout) marks the nag as acted on, so the
    // next nag's last_nag_ignored is accurate. Celebration tokens won't match a nag.
    if (message.kind && message.kind !== "timeout" && typeof message.displayToken === "number") {
      await markNagActed(message.displayToken)
    }
    logEvent("feedback", { kind: message.kind ?? null })
    const goal = await getGoal()
    if (goal) {
      const now = Date.now()
      // "5분만" / "30분 조용히" quiet the gauge; other feedback just dismisses the toast.
      if (message.kind === "break") await dispatch({ type: "snooze", until: now + 5 * 60_000, ts: now }, goal)
      else if (message.kind === "snooze") await dispatch({ type: "snooze", until: now + 30 * 60_000, ts: now }, goal)
      else if (message.kind === "related") {
        // "목표와 관련 있어요": the user says this page IS on-goal (the nag was wrong) →
        // flip the active page to OK so S recovers. ("accepted"/"잘 잡았어요" agrees with
        // the nag, so it must NOT recover.)
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        const pageKey = tab?.url ? pageKeyOf(tab.url) : null
        if (pageKey) {
          klog(`related → OK recover ${pageKey}`)
          await dispatch({ type: "nav", pageKey, verdict: "OK", ts: now }, goal)
        }
      }
    }
    return { ok: true }
  }
  return { error: "unknown message" }
}

chrome.runtime.onMessage.addListener((message: PopupMessage, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse)
  return true
})

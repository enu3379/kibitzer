// Kibitzer (next) — serverless MV3 service worker.
//
// Authoritative pipeline (Tier-0-only first slice; the Ollama Tier 1/2 layer and the
// IndexedDB SSOT are follow-up PRs):
//   page settles / tab activates → embed title vs goal (Tier 0 WASM) → verdict
//   → gauge (degraded mode) → S drains on drift → S=0 → real nag notification.
// A 1-min alarm feeds heartbeats so dwell time (not click count) drives the gauge.

import { getGoal, setGoal, type SessionGoal } from "./lib/session.ts"
import { embedText, embedTexts, judgeTier0 } from "./lib/tier0.ts"
import { addExemplar, admissionEligible, admitAnchor, loadRefs, setDerived } from "./lib/relevance.ts"
import { filterDerivedPhrases, MAX_PHRASES } from "./lib/goalEnrichment.ts"
import { currentState, dispatch, enterNeutral, flushOutbox, resetState, setActivePage, testNag } from "./lib/gaugeRuntime.ts"
import { enrichGoal, getOllamaConfig, ollamaEnabled, setOllamaConfig, testOllama, tier1Rescue } from "./lib/tier12.ts"
import { getPersonaKey, personaChoices, setPersonaKey } from "./lib/personas.ts"
import { getProviderHealth } from "./lib/providerHealth.ts"
import { clearBadge } from "./lib/badge.ts"
import { clearEvents, exportEvents, logEvent } from "./lib/events.ts"
import { getSettings, setSettings, type Settings } from "./lib/settings.ts"
import { clearStore, kvGet, kvSet, OBS_STORE } from "./lib/db.ts"
import { DwellScheduler } from "./lib/dwellScheduler.ts"
import { markNagActed, recentTitles, recordObservation } from "./lib/history.ts"
import { clearLog, exportLog, klog, logText } from "./lib/klog.ts"
import { shouldDropUrl } from "./lib/domainFilter.ts"
import { hostOf, pageKeyOf } from "./lib/url.ts"

const HEARTBEAT_ALARM = "kibitzer-next-heartbeat"

let lastObservedKey: string | null = null

// A page is judged only after it has been dwelt on for OBSERVE_DWELL_MS of sustained
// attention — a quick glance / bounce never counts, embeds, or pollutes recent-titles.
// (Sensitive pages are handled immediately, without waiting.) The scheduler keeps the
// pending observation in the SSOT so a teardown mid-dwell is recovered on the next wake.
const OBSERVE_DWELL_MS = 5000
const dwell = new DwellScheduler({
  dwellMs: OBSERVE_DWELL_MS,
  judge: (pending) => judgeAndDispatch(pending.url, pending.title, pending.obsKey),
})

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
  // Privacy gate: sensitive pages pause the gauge immediately — no dwell, no judging.
  if (shouldDropUrl(url)) {
    await dwell.cancel() // drop any prior page's pending dwell; this page never counts
    lastObservedKey = obsKey
    klog(`drop (sensitive) ${pageKey}`)
    // NEUTRAL, not just a one-tick pause: we won't judge this page, so the previous page's
    // verdict must not keep draining/recovering S across the heartbeats spent here.
    await enterNeutral(pageKey, goal)
    return
  }
  // Stop integrating the page just left the moment a new page is observed: hold the gauge
  // NEUTRAL (no drain / no recover) through the dwell, so a possibly-stale verdict can't move S
  // while we wait. The judgement resumes integration all at once when it lands. enterNeutral
  // no-ops if we already hold this page or are already neutral (e.g. same-page title churn).
  await enterNeutral(pageKey, goal)
  // A new candidate atomically REPLACES the previous checkpoint (a single durable write) —
  // no cancel-then-schedule gap where a teardown in between would leave nothing to recover.
  await dwell.schedule(url, title, obsKey)
}

/** True iff, after the async embed/rescue, we are STILL judging the same page under the same
 *  goal session — i.e. the user hasn't navigated away and the goal hasn't been changed/cleared.
 *  Guards against applying a stale verdict to whatever page/goal is current now (B2). */
async function stillJudging(pageKey: string, epoch: number): Promise<boolean> {
  const goal = await getGoal()
  if (!goal || goal.epoch !== epoch) return false // goal changed or cleared mid-judge
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return !!tab?.url && pageKeyOf(tab.url) === pageKey // still on the judged page
}

/** Embed title vs goal (Tier 0), optionally rescue via Tier 1 (Ollama), and feed the
 *  verdict into the gauge — invoked by the dwell scheduler once the dwell has elapsed. */
async function judgeAndDispatch(url: string, title: string, obsKey: string): Promise<void> {
  const goal = await getGoal()
  if (!goal) return
  const pageKey = pageKeyOf(url)
  if (!pageKey) return
  const epoch = goal.epoch
  lastObservedKey = obsKey
  const urlHost = hostOf(url)
  const tauOk = (await getSettings()).tauOk
  const refs = await loadRefs()
  const { score, verdict: tier0Verdict, vector: titleVec, parts } = await judgeTier0(goal.text, title, tauOk, refs)
  const enabled = await ollamaEnabled()
  let verdict = tier0Verdict
  let tierReached = 0
  if (verdict === "DRIFT" && enabled) {
    // Give Tier-1 the recent-visit context (mirrors the server) so it can judge the escalation
    // pattern, not just this title in isolation.
    verdict = await tier1Rescue(goal.text, title, urlHost, await recentTitles()) // Tier 1 may rescue to OK
    tierReached = 1
  }
  // B2: the dwell + embed + Tier-1 rescue took time; the user may have navigated away or
  // changed the goal. Applying this verdict now would drive the gauge / active page for a
  // page they left. Drop it — the page they're on now gets its own dwell + judge.
  if (!(await stillJudging(pageKey, epoch))) {
    klog(`judge dropped (page/goal moved on) ${pageKey}`)
    // This page was never actually judged (lastObservedKey was set optimistically at entry).
    // Clear the debounce marker so returning to it later re-judges, instead of observe()
    // silently debouncing it as "already judged" — which would leave it never re-judged.
    if (lastObservedKey === obsKey) lastObservedKey = null
    return
  }
  // Learn the recency anchor from confirmed-OK pages (the guard blocks anchor-only OKs).
  if (verdict === "OK" && admissionEligible(parts, refs.derived.length > 0, verdict, tierReached)) {
    await admitAnchor(titleVec)
  }
  klog(`observe ${pageKey} tier0=${tier0Verdict}(${score.toFixed(2)} ex=${parts.exemplarScore.toFixed(2)} an=${parts.anchorScore.toFixed(2)}) final=${verdict} mode=${enabled ? "ollama" : "degraded"}`)
  logEvent("observe", { pageKey, host: urlHost, tier0: tier0Verdict, score: Number(score.toFixed(3)), exemplar: Number(parts.exemplarScore.toFixed(3)), anchor: Number(parts.anchorScore.toFixed(3)), derived: Number(parts.derivedScore.toFixed(3)), verdict, mode: enabled ? "ollama" : "degraded" })
  const now = Date.now()
  await setActivePage({ pageKey, title, urlHost, score })
  await recordObservation({ title, urlHost, verdict, ts: now }) // recent_titles / repeat context
  await dispatch(
    { type: "nav", pageKey, verdict, r0: score, tauOk, degraded: !enabled, ts: now },
    goal,
  )
}

async function observeActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab) await observe(tab.url, tab.title)
}

/** Expand the goal into cross-lingual derived exemplars (Tier 1 → embed → dedup → store).
 *  Fire-and-forget on goal change; dropped if the goal moves on while enriching. */
async function enrichGoalDerived(goal: SessionGoal): Promise<void> {
  if (!(await ollamaEnabled())) return
  try {
    const phrases = await enrichGoal(goal.text)
    if (phrases.length === 0) return
    const derived = await filterDerivedPhrases(phrases, goal.text, MAX_PHRASES, embedTexts)
    const current = await getGoal()
    if (!current || current.epoch !== goal.epoch) return // goal changed meanwhile
    await setDerived(derived.map((d) => d.vector))
    klog(`goal enriched: ${derived.length} phrases [${derived.map((d) => d.phrase).join(" · ")}]`)
    logEvent("enrich", { count: derived.length, phrases: derived.map((d) => d.phrase) })
  } catch (error) {
    klog(`goal enrichment error: ${String(error)}`)
  }
}

async function ensureHeartbeat(): Promise<void> {
  // Create only if absent — re-`create`ing with the same name resets the period, which would
  // delay the next heartbeat up to a full minute every time the goal is (re)declared.
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM)
  if (!existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 })
}

/** True only when a Chrome window has OS focus AND the user is active. chrome.idle is
 *  system-wide (idle stays "active" while the user works in another app), so the gauge
 *  must also require Chrome to be the focused window — otherwise S drains and nags fire
 *  while Chrome is off-screen. Unknown → assume present (never over-suppress). */
const PRESENCE_KEY = "presence-last"

// Log presence TRANSITIONS to the event store so replay can reconstruct real idle/focus time
// (B7). Only the heartbeat calls this — with the SAME definition the gauge uses
// (browserPresent = Chrome focused AND idle-active) — so all sources agree; the idle/focus
// handlers just drive the live gauge. The last state is DURABLE (a module `let` reset to null
// on every SW wake would log a redundant event ~every minute and could evict older observes
// under the event cap), so a transition is logged at most once per real change.
async function notePresence(present: boolean): Promise<void> {
  const last = await kvGet<boolean>(PRESENCE_KEY)
  if (last === present) return
  await kvSet(PRESENCE_KEY, present)
  logEvent("presence", { present })
}

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

// On every service-worker spin-up (wake or browser start), recover work a prior lifetime
// checkpointed but was torn down before finishing: deliver any queued gauge effects
// (atomic outbox, B1) and resume a dwell that was mid-flight (B3). The 1-min heartbeat
// alarm guarantees a wake within a minute, bounding recovery latency.
void flushOutbox()
void dwell.reconcile()
chrome.runtime.onStartup.addListener(() => {
  void flushOutbox()
  void dwell.reconcile()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return
  void getGoal().then(async (goal) => {
    if (!goal) return
    // Only drain while Chrome is focused and the user is active; otherwise pause.
    const present = await browserPresent()
    await notePresence(present) // record presence transitions off the same signal the gauge uses
    await dispatch({ type: present ? "heartbeat" : "inactive", ts: Date.now() }, goal)
  })
})

chrome.idle.setDetectionInterval(60)
chrome.idle.onStateChanged.addListener((state) => {
  void getGoal().then(async (goal) => {
    if (!goal) return
    if (state === "active") return observeActiveTab()
    // Left the machine: a page glanced at for 1s must not judge 5s later — drop the dwell,
    // not just pause the gauge (sustained-attention requirement).
    await dwell.cancel()
    await dispatch({ type: "inactive", ts: Date.now() }, goal)
  })
})

// Chrome losing OS focus (user switched to another app) pauses the gauge; regaining it
// re-observes the active tab. Complements the system-wide idle signal above.
chrome.windows.onFocusChanged.addListener((windowId) => {
  const lostFocus = windowId === chrome.windows.WINDOW_ID_NONE
  void getGoal().then(async (goal) => {
    if (!goal) return
    if (lostFocus) {
      await dwell.cancel() // focus lost mid-dwell: the glance never earned a judgement
      await dispatch({ type: "inactive", ts: Date.now() }, goal)
      return
    }
    return observeActiveTab()
  })
})

// Feedback from the OS-notification fallback (buttons: 0=related, 1=break), routed
// through the same handler as the in-page toast. The notification id is `kbz-<token>`; carry
// that displayToken through so markNagActed records the nag as acted (parity with the toast).
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith("kbz-")) return
  const displayToken = Number(notificationId.slice(4))
  void handleMessage({
    type: "kibitzer:toast-feedback",
    kind: buttonIndex === 0 ? "related" : "break",
    displayToken: Number.isFinite(displayToken) ? displayToken : undefined,
  })
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
  settings?: Partial<Settings>
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
  if (message?.type === "get-settings") {
    return await getSettings()
  }
  if (message?.type === "set-settings") {
    return await setSettings(message.settings ?? {})
  }
  if (message?.type === "delete-all-data") {
    // Wipe activity data (gauge, history, learned vectors, events, observations, log);
    // keep the goal, Ollama config, persona, and settings.
    await resetState()
    await clearEvents()
    await clearStore(OBS_STORE)
    await clearLog()
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
      // Accept only a positive, finite budget (defence in depth with the popup + config guard).
      typeof message.minutes === "number" && message.minutes > 0 ? message.minutes : null,
    )
    // Restart the gauge when the goal actually changes (text OR minutes → new revision)
    // or is cleared.
    if (!goal || previous?.epoch !== goal.epoch) await resetState()
    logEvent("goal", { text: goal?.text ?? null, minutes: goal?.availableMinutes ?? null, revision: goal?.revision ?? null })
    void ensureHeartbeat()
    await dwell.cancel() // a pending dwell from the old goal must not judge under the new one
    if (goal) {
      lastObservedKey = null // re-judge the active page under the new goal
      // Test shortcut: goal "알림보기" fires a nag notification right away.
      if (goal.text === "알림보기") await testNag(goal)
      void observeActiveTab()
      // Enrich the goal into cross-lingual Tier-0 exemplars (only when it actually changed).
      if (previous?.epoch !== goal.epoch) void enrichGoalDerived(goal)
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
          // Learn: add this page's embedding as a goal exemplar so this class of page
          // stops drifting at Tier-0 (the user-taught relevance loop).
          if (tab?.title && tab.url && !shouldDropUrl(tab.url)) {
            try {
              await addExemplar(await embedText(tab.title))
              logEvent("exemplar", { pageKey, title: tab.title })
            } catch {
              // embedding failed — the S-recovery above still applies.
            }
          }
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

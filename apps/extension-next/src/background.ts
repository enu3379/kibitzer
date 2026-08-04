// Kibitzer — serverless MV3 service worker.
//
// Authoritative pipeline:
//   page settles / tab activates → embed title vs goal (Tier 0 WASM) → verdict
//   → gauge (degraded mode) → S drains on drift → S=0 → real nag notification.
// A 1-min alarm feeds heartbeats so dwell time (not click count) drives the gauge.

import { getGoal, setGoal, type SessionGoal } from "./lib/session.ts"
import { embedText, embedTexts, judgeTier0 } from "./lib/tier0.ts"
import { addExemplar, admissionEligible, admitAnchor, loadRefs, setDerived } from "./lib/relevance.ts"
import { filterDerivedPhrases, MAX_PHRASES } from "./lib/goalEnrichment.ts"
import { currentState, dispatch, enterNeutral, flushOutbox, PROVIDER_ALERT_ID, resetState, setActivePage, testNag } from "./lib/gaugeRuntime.ts"
import { enrichGoal, judgeEnabled, testRoute, tier1Rescue } from "./lib/tier12.ts"
import {
  addProviderKey,
  connectProvider,
  disconnectProvider,
  getJudgeSettings,
  removeProviderKey,
  setRoutes,
  toPublicSettings,
  type ProviderId,
  type TierName,
  type TierRoute,
} from "./lib/providers.ts"
import { getUsage } from "./lib/usage.ts"
import { getPersonaKey, personaChoices, setPersonaKey } from "./lib/personas.ts"
import { clearProviderHealth, getProviderHealth } from "./lib/providerHealth.ts"
import { clearBadge } from "./lib/badge.ts"
import { clearEvents, exportEvents, logEvent } from "./lib/events.ts"
import { getSettings, localPdfPolicyMatches, setSettings, type Settings } from "./lib/settings.ts"
import { clearStore, kvGet, kvSet, OBS_STORE } from "./lib/db.ts"
import { DwellScheduler, PENDING_DWELL_KEY } from "./lib/dwellScheduler.ts"
import { isPendingDwell, PENDING_DWELL_VERSION, type PendingDwell } from "./lib/dwell.ts"
import { markNagActed, recentTitles, recordObservation } from "./lib/history.ts"
import { clearVisits, noteHeartbeat, noteInactive, noteJudged, noteObserve, noteVerdict } from "./lib/visits.ts"
import { clearSessionSummary, dismissSessionSummary, finalizeSession, generateSummaryComment, getSessionSummary } from "./lib/sessionSummary.ts"
import { clearSessionHistory } from "./lib/sessionHistory.ts"
import { clearLog, exportLog, klog, logText } from "./lib/klog.ts"
import { isUserAllowedUrl, isUserBlockedUrl, shouldDropUrl } from "./lib/domainFilter.ts"
import { getDomainLists, initDomainLists, setDomainLists } from "./lib/domainLists.ts"
import { truncateCodePoints } from "./providers/judgeParsing.ts"
import { describeObservableUrl } from "./lib/url.ts"
import { maybeOpenLocalPdfPrompt } from "./lib/localPdfPrompt.ts"
import { browserPresent, isFocusedWindow } from "./lib/presence.ts"

const HEARTBEAT_ALARM = "kibitzer-next-heartbeat"

// document.title is page-controlled and unbounded (a hostile page can set megabytes), and the
// title flows into cloud payloads, recent-titles context, and durable observation records — so
// every title is clamped at its ingress points. 512 code points is far beyond any legitimate
// title. (Excerpts have their own cap in pageExcerpt.ts; the goal's cap lives in session.ts.)
const TITLE_MAX_CHARS = 512

let lastObservedKey: string | null = null

// A page is judged only after it has been dwelt on for OBSERVE_DWELL_MS of sustained
// attention — a quick glance / bounce never counts, embeds, or pollutes recent-titles.
// (Sensitive pages are handled immediately, without waiting.) The scheduler keeps the
// pending observation in the SSOT so a teardown mid-dwell is recovered on the next wake.
const OBSERVE_DWELL_MS = 5000
const dwell = new DwellScheduler({
  dwellMs: OBSERVE_DWELL_MS,
  judge: judgeAndDispatch,
})

async function holdLocalPdfDisabled(goal: SessionGoal): Promise<void> {
  const disabledKey = "local-pdf#disabled"
  // A judged PDF may have an open visit interval. OFF means observation stops now, even if
  // the gauge was already neutral or a stale observe later tries to resume the interval.
  await noteInactive(Date.now(), goal.epoch)
  // Cancel BEFORE the debounce below: the page just left may still have a dwell pending, and
  // an early return here would let it fire against this PDF and be dropped — leaving the
  // gauge frozen on that page with nothing armed (same defect as the main observe debounce).
  await dwell.cancel()
  if (lastObservedKey === disabledKey) return
  lastObservedKey = disabledKey
  klog("drop (local-pdf disabled)")
  await enterNeutral(disabledKey, goal)
}

/** True iff the gauge pipeline already accounts for this observation: it is integrating
 *  this very page's verdict, or this exact observation's dwell is still pending. Only those
 *  states make the lastObservedKey debounce safe to honor — lastObservedKey is written by
 *  judgeAndDispatch, not by observe, so after judged-X → unjudged-Y → back-to-X within Y's
 *  dwell the key still names X while the gauge holds Y with a null verdict; Y's dwell then
 *  fires against the wrong active tab and is dropped, leaving NOTHING armed. An early return
 *  on the bare key match in that state froze S indefinitely (no drain, no recovery, no drift
 *  detection) until some unrelated event happened to observe a different key. */
async function gaugeAccountsFor(pageKey: string, obsKey: string): Promise<boolean> {
  const state = await currentState()
  if (state.activePageKey === pageKey && state.activeVerdict != null) return true
  const pending = await kvGet<unknown>(PENDING_DWELL_KEY)
  return isPendingDwell(pending) && pending.obsKey === obsKey
}

/** Entry for every observation trigger (nav / activate / SPA). Debounces per page, pauses
 *  immediately on sensitive pages, and otherwise schedules the judgement after a dwell so
 *  transient pages don't count. */
async function observe(url: string | undefined, title: string | undefined): Promise<void> {
  const goal = await getGoal()
  if (!goal || !url) return
  const descriptor = describeObservableUrl(url)
  let localPdfSettings: Settings | null = null
  if (descriptor?.kind === "local_pdf") {
    localPdfSettings = await getSettings()
    if (!localPdfSettings.observeLocalPdfs) {
      await holdLocalPdfDisabled(goal)
      void maybeOpenLocalPdfPrompt(descriptor.pageKey).catch(() => klog("local-pdf prompt unavailable"))
      return
    }
  }
  if (!title) return
  title = truncateCodePoints(title, TITLE_MAX_CHARS)
  if (!descriptor) {
    // Non-http(s) internal pages (chrome://newtab, chrome://extensions, about:blank, the web
    // store, …) get no page key, so they can never be judged. Treat them exactly like the
    // sensitive drop below: cancel any pending dwell and hold the gauge NEUTRAL — otherwise
    // observe() returned here BEFORE the neutral hold, leaving the page-just-left's verdict as
    // activeVerdict so heartbeats kept draining/recovering S against a page the user has left
    // (and a later nag referenced that stale page). Synthesize a stable opaque key so the hold
    // records a distinct, non-null activePageKey; the protocol keeps it readable in the trace.
    let protocol = "internal"
    try {
      protocol = new URL(url).protocol // e.g. "chrome:", "about:"
    } catch {
      // Unparseable URL — keep the "internal" constant.
    }
    const internalPageKey = `internal#${protocol}`
    const obsKey = `${internalPageKey}\n${title}`
    // Cancel BEFORE the storm debounce: returning to an already-held internal page must still
    // kill the dwell of the page just left, or that dwell fires against this chrome:// tab,
    // is dropped, and the gauge freezes on the abandoned page with nothing armed.
    await dwell.cancel() // drop any prior page's pending dwell; this page never counts
    if (obsKey === lastObservedKey) return // same internal page storming — already held
    lastObservedKey = obsKey
    klog(`drop (internal) ${protocol}`)
    await enterNeutral(internalPageKey, goal)
    return
  }
  const { pageKey } = descriptor
  // Visit tracking must see every observation trigger — including a presence-resume on the
  // same page, which the lastObservedKey debounce below hides. The reducer only reopens an
  // interval for already-judged pages, so this can't credit unjudged/sensitive pages (internal
  // pages returned above, before this point).
  await noteObserve(pageKey, Date.now(), goal.epoch)
  // Debounce on pageKey+title, not pageKey alone: an SPA route change that keeps the
  // path but swaps the title (YouTube video → video) still re-judges, while an update
  // storm on the identical page is collapsed (the old S 0↔30 yo-yo guard). The key match
  // alone is NOT proof the gauge still reflects this page (see gaugeAccountsFor) — a tab/
  // window bounce back to a judged page within another page's dwell used to early-return
  // here and freeze the gauge on the abandoned page. Honor the debounce only while the
  // gauge demonstrably accounts for this observation; otherwise re-enter the pipeline
  // (enterNeutral no-ops for a page whose verdict we still hold, and schedule() replaces
  // the stale checkpoint atomically, so re-entry is idempotent).
  const localPdfPolicyRevision = localPdfSettings?.localPdfPolicyRevision ?? null
  const obsKey = `${pageKey}\n${title}${localPdfPolicyRevision == null ? "" : `\npolicy:${localPdfPolicyRevision}`}`
  if (obsKey === lastObservedKey && (await gaugeAccountsFor(pageKey, obsKey))) return
  // Privacy gate: sensitive pages pause the gauge immediately — no dwell, no judging.
  // The user lists load once per worker lifetime; awaiting the memoized init here keeps the
  // synchronous gate accurate from the very first observation after a wake.
  await initDomainLists()
  if (descriptor.kind === "web" && shouldDropUrl(url)) {
    await dwell.cancel() // drop any prior page's pending dwell; this page never counts
    lastObservedKey = obsKey
    // The page must never be NAMED anywhere durable — not in this log line, and not as the
    // neutral hold's activePageKey (the gauge trace klog and the exportable `tick` events both
    // echo activePageKey, so passing the real host#hash here would leak the dropped host
    // into ~/Downloads exports). Opaque constants mirror the internal-page path above;
    // distinct dropped pages don't need distinct holds (once neutral, enterNeutral no-ops).
    // Only the CATEGORY differs, so the user can tell their own list fired vs the built-in.
    if (isUserBlockedUrl(url)) {
      klog("drop (user-blocked)")
      await enterNeutral("user-blocked", goal)
    } else {
      klog("drop (sensitive)")
      await enterNeutral("sensitive#drop", goal)
    }
    return
  }
  // Stop integrating the page just left the moment a new page is observed: hold the gauge
  // NEUTRAL (no drain / no recover) through the dwell, so a possibly-stale verdict can't move S
  // while we wait. The judgement resumes integration all at once when it lands. enterNeutral
  // no-ops if we already hold this page or are already neutral (e.g. same-page title churn).
  await enterNeutral(pageKey, goal)
  // A new candidate atomically REPLACES the previous checkpoint (a single durable write) —
  // no cancel-then-schedule gap where a teardown in between would leave nothing to recover.
  const candidate = {
    version: PENDING_DWELL_VERSION,
    pageKey,
    title,
    urlHost: descriptor.urlHost,
    kind: descriptor.kind,
    localPdfPolicyRevision,
    obsKey,
  } satisfies Parameters<typeof dwell.schedule>[0]
  await dwell.schedule(candidate)
  // An OFF edge can interleave with any await above or inside schedule(). Remove only this
  // stale revision; an OFF→ON observation has a different token and must keep its checkpoint.
  if (localPdfPolicyRevision != null && !(await localPdfPolicyMatches(localPdfPolicyRevision))) {
    await dwell.cancelCandidate(candidate)
    await noteInactive(Date.now(), goal.epoch)
  }
}

/** Return the current tab only while it still matches this candidate and privacy/opt-in
 *  policy. Re-run after slow model calls so an OFF toggle or navigation always wins. */
async function currentJudgingTab(
  pageKey: string,
  kind: PendingDwell["kind"],
  localPdfPolicyRevision: number | null,
  epoch: number,
): Promise<chrome.tabs.Tab | null> {
  const goal = await getGoal()
  if (!goal || goal.epoch !== epoch) return null
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.url) return null
  const current = describeObservableUrl(tab.url)
  if (!current || current.pageKey !== pageKey || current.kind !== kind) return null
  if (kind === "local_pdf") {
    return localPdfPolicyRevision != null && (await localPdfPolicyMatches(localPdfPolicyRevision)) ? tab : null
  }
  await initDomainLists()
  return shouldDropUrl(tab.url) ? null : tab
}

/** Embed title vs goal (Tier 0), optionally rescue via Tier 1 (Ollama), and feed the
 *  verdict into the gauge — invoked by the dwell scheduler once the dwell has elapsed. */
async function judgeAndDispatch(pending: PendingDwell): Promise<void> {
  const goal = await getGoal()
  if (!goal) return
  const { pageKey, title, urlHost, obsKey, kind, localPdfPolicyRevision } = pending
  const epoch = goal.epoch
  lastObservedKey = obsKey
  const initialTab = await currentJudgingTab(pageKey, kind, localPdfPolicyRevision, epoch)
  if (!initialTab) {
    if (lastObservedKey === obsKey) lastObservedKey = null
    return
  }
  // User allowlist (options 사이트 pane): this host is always on-goal — skip the Tier-0
  // embed and the Tier-1/2 judges entirely and dispatch OK (no LLM spend, S recovers).
  // The blocklist (static or user) wins inside isUserAllowedUrl. The page is still recorded
  // as a normal observation — it isn't private, just pre-judged — so recent-titles and the
  // session summary stay correct. The memoized init covers a reconcile() that reaches here
  // before any observe() ran in a fresh worker.
  await initDomainLists()
  if (kind === "web" && initialTab.url && isUserAllowedUrl(initialTab.url)) {
    // B2 (same as below): the dwell took time; drop the verdict if the user moved on.
    if (!(await currentJudgingTab(pageKey, kind, localPdfPolicyRevision, epoch))) {
      klog(`judge dropped (page/goal moved on) ${pageKey}`)
      if (lastObservedKey === obsKey) lastObservedKey = null
      return
    }
    klog(`observe ${pageKey} user-allow final=OK`)
    // No `score` field on purpose: replay's tau sweep reads only Tier-0-scored observes,
    // and this page never got one — `mode` records why.
    logEvent("observe", { pageKey, host: urlHost, verdict: "OK", mode: "user-allow" })
    const now = Date.now()
    await setActivePage({ pageKey, title, urlHost, score: 1, kind, localPdfPolicyRevision })
    await recordObservation({ title, urlHost, verdict: "OK", ts: now }) // recent_titles / repeat context
    await noteJudged(pageKey, title, urlHost, "OK", now, epoch, await browserPresent()) // session-summary dwell/verdict
    // No r0/tauOk: activeMargin stays null → full-speed recovery (the same event shape as
    // the "관련 있어요" user-override OK).
    await dispatch({ type: "nav", pageKey, verdict: "OK", ts: now }, goal)
    return
  }
  const tauOk = (await getSettings()).tauOk
  const refs = await loadRefs()
  const { score, verdict: tier0Verdict, vector: titleVec, parts } = await judgeTier0(goal.text, title, tauOk, refs)
  const enabled = await judgeEnabled()
  let verdict = tier0Verdict
  let tierReached = 0
  if (verdict === "DRIFT" && enabled) {
    const titles = await recentTitles()
    // Do not start a provider request after a local-PDF OFF edge that landed during Tier 0.
    if (!(await currentJudgingTab(pageKey, kind, localPdfPolicyRevision, epoch))) {
      if (lastObservedKey === obsKey) lastObservedKey = null
      return
    }
    // Give Tier-1 the recent-visit context (mirrors the server) so it can judge the escalation
    // pattern, not just this title in isolation.
    verdict = await tier1Rescue(goal.text, title, urlHost, titles) // Tier 1 may rescue to OK
    tierReached = 1
  }
  // B2: the dwell + embed + Tier-1 rescue took time; the user may have navigated away or
  // changed the goal. Applying this verdict now would drive the gauge / active page for a
  // page they left. Drop it — the page they're on now gets its own dwell + judge.
  if (!(await currentJudgingTab(pageKey, kind, localPdfPolicyRevision, epoch))) {
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
  await setActivePage({ pageKey, title, urlHost, score, kind, localPdfPolicyRevision })
  await recordObservation({ title, urlHost, verdict, ts: now }) // recent_titles / repeat context
  // Only open a timed visit interval if the user is present now — this verdict may have landed
  // after the dwell/embed while Chrome sits unfocused/idle on the same page.
  await noteJudged(pageKey, title, urlHost, verdict, now, epoch, await browserPresent()) // session-summary dwell/verdict
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
  if (!(await judgeEnabled())) return
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

// Presence (Chrome focused AND idle-active) is defined once in ./lib/presence.ts so the gauge
// heartbeat here and the nudge-delivery gate in gaugeRuntime agree on the exact same signal.
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

// --- observation surface ---------------------------------------------------------
//
// Every listener is scoped to the active tab of the FOCUSED window. Tab.active is per-window
// ("does not necessarily mean the window is focused"), so with two Chrome windows BOTH have an
// active tab — and a title-churning page (SPA, live news, a dev server) in the unfocused window
// would keep firing observe(): each hit REPLACES the single dwell checkpoint, starving the
// focused page's judgement, while its own judgement is dropped by the lastFocusedWindow-scoped
// stillJudging — wedging the gauge in a NEUTRAL hold (S frozen, no drift detection). When
// Chrome is entirely unfocused, observations drop too — safe and intended: windows.onFocusChanged
// already re-observes the active tab on focus regain (and cancels the dwell on focus loss).

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  // Fire on page-load completion AND on title changes — SPAs (YouTube, etc.) swap the
  // title without a fresh "complete", and that's how their route changes surface here.
  if (!tab.active) return
  if (changeInfo.status === "complete" || changeInfo.title !== undefined) {
    void isFocusedWindow(tab.windowId).then((focused) => (focused ? observe(tab.url, tab.title) : undefined))
  }
})

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void isFocusedWindow(windowId).then((focused) =>
    focused
      ? chrome.tabs.get(tabId).then(
          (tab) => observe(tab.url, tab.title),
          () => undefined,
        )
      : undefined,
  )
})

// SPA in-page navigation (history.pushState) — no "complete" event fires, so observe the
// top frame directly. tabs.onUpdated(title) catches the rest.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return
  void chrome.tabs.get(details.tabId).then(
    async (tab) =>
      tab.active && (await isFocusedWindow(tab.windowId)) ? observe(tab.url ?? details.url, tab.title) : undefined,
    () => undefined,
  )
})

// --- heartbeat / presence --------------------------------------------------------

chrome.runtime.onInstalled.addListener(ensureHeartbeat)
chrome.runtime.onStartup.addListener(ensureHeartbeat)

// --- first-run onboarding --------------------------------------------------------

// Open the onboarding wizard exactly once per profile. onInstalled also fires for
// extension/Chrome updates (and unpacked reloads report "update"), so gate on the
// "install" reason AND a storage flag — the flag survives dev reinstalls and can be
// cleared later by a "튜토리얼 다시 보기" control.
const ONBOARDING_SHOWN_KEY = "kibitzer:onboarding-shown:v1"
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== "install") return
  void (async () => {
    const stored = await chrome.storage.local.get(ONBOARDING_SHOWN_KEY)
    if (stored[ONBOARDING_SHOWN_KEY]) return
    // Flag only after the tab actually opened — if tabs.create fails, the next
    // install still gets the wizard.
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") })
    await chrome.storage.local.set({ [ONBOARDING_SHOWN_KEY]: Date.now() })
  })()
})

// On every service-worker spin-up (wake or browser start), recover work a prior lifetime
// checkpointed but was torn down before finishing: deliver any queued gauge effects
// (atomic outbox, B1) and resume a dwell that was mid-flight (B3). The 1-min heartbeat
// alarm guarantees a wake within a minute, bounding recovery latency.
// Kick the user domain-lists load early so the synchronous privacy gate is warm before the
// first observation (observe/judge also await the memoized init as a readiness barrier).
void initDomainLists()
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
    const now = Date.now()
    // Once-a-minute durable checkpoint for the visit tracker (bounds teardown loss).
    void (present ? noteHeartbeat(now, goal.epoch) : noteInactive(now, goal.epoch))
    await dispatch({ type: present ? "heartbeat" : "inactive", ts: now }, goal)
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
    void noteInactive(Date.now(), goal.epoch)
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
      void noteInactive(Date.now(), goal.epoch)
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
  if (notificationId === PROVIDER_ALERT_ID) {
    void chrome.runtime.openOptionsPage()
    void chrome.notifications.clear(notificationId)
    return
  }
  if (notificationId.startsWith("kbz-")) void chrome.notifications.clear(notificationId)
})

// --- popup messaging -------------------------------------------------------------

interface PopupMessage {
  type?: string
  goal?: string
  minutes?: number | null
  kind?: string
  persona?: string
  displayToken?: number
  sourceTabId?: number
  settings?: Partial<Settings>
  // provider settings (options AI 판정 pane)
  provider?: ProviderId
  tier?: TierName
  model?: string
  name?: string
  value?: string
  keyId?: string
  routes?: Partial<Record<TierName, Partial<TierRoute>>>
  days?: number
  // user domain lists (options 사이트 pane)
  lists?: { block?: string[]; allow?: string[] }
}

async function applySettingsPatch(
  patch: Partial<Settings>,
  reobserveActiveTab = true,
): Promise<Settings> {
  const before = await getSettings()
  const next = await setSettings(patch)
  // Compare the revision, not the boolean: it is minted inside setSettings' write queue and
  // bumped once per edge, so an OFF→ON pair that lands between these two reads still counts.
  if (before.localPdfPolicyRevision !== next.localPdfPolicyRevision) {
    // A setting change supersedes both a checkpointed and an already-running PDF judge.
    // Re-observe the current tab so OFF holds it neutral and ON begins a fresh full dwell.
    await dwell.cancel()
    lastObservedKey = null
    if (reobserveActiveTab && await getGoal()) void observeActiveTab()
  }
  return next
}

interface EnableLocalPdfResult {
  ok: boolean
  settingEnabled: boolean
}

async function enableLocalPdfObservation(sourceTabId: number): Promise<EnableLocalPdfResult> {
  let settingEnabled = false
  try {
    settingEnabled = (await getSettings()).observeLocalPdfs
    const initialTab = await chrome.tabs.get(sourceTabId)
    const initialDescriptor = initialTab.url ? describeObservableUrl(initialTab.url) : null
    if (initialDescriptor?.kind !== "local_pdf") return { ok: false, settingEnabled }

    const next = await applySettingsPatch({ observeLocalPdfs: true }, false)
    settingEnabled = next.observeLocalPdfs
    if (!settingEnabled) return { ok: false, settingEnabled }

    // This click establishes a fresh source-PDF observation even if another settings event
    // won the OFF→ON race first. Do not inherit an earlier dwell deadline.
    await dwell.cancel()
    lastObservedKey = null
    await chrome.windows.update(initialTab.windowId, { focused: true })
    await chrome.tabs.update(sourceTabId, { active: true })

    // Navigation can race the window switch. Re-read both identity and active state before
    // observing so an old PDF snapshot can never schedule dwell for the wrong page.
    const currentTab = await chrome.tabs.get(sourceTabId)
    const currentDescriptor = currentTab.url ? describeObservableUrl(currentTab.url) : null
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: currentTab.windowId })
    if (
      currentDescriptor?.kind !== "local_pdf" ||
      activeTab?.id !== sourceTabId ||
      !currentTab.url
    ) return { ok: false, settingEnabled }

    await observe(currentTab.url, currentTab.title)
    return { ok: true, settingEnabled }
  } catch {
    return { ok: false, settingEnabled }
  }
}

async function handleMessage(message: PopupMessage): Promise<unknown> {
  if (message?.type === "get-state") {
    const goal = await getGoal()
    // Advance the gauge to "now" so the popup shows a live value between the 1-min heartbeat
    // alarms (a nag can still fire here if S reaches 0) — but gate on presence exactly like the
    // alarm heartbeat. The popup polls this every ~1.5s; without the gate, opening it right
    // after being away integrated the whole un-rebased gap at full DRIFT drain. `inactive`
    // rebases the reducer clock without integrating. (No notePresence here — per the alarm's
    // comment, only the alarm heartbeat logs presence transitions.)
    if (goal) await dispatch({ type: (await browserPresent()) ? "heartbeat" : "inactive", ts: Date.now() }, goal)
    const [state, enabled, persona, health] = await Promise.all([
      currentState(),
      judgeEnabled(),
      getPersonaKey(),
      getProviderHealth(),
    ])
    return {
      goal,
      s: Math.round(state.s),
      accelTier: state.accelTier,
      snoozedUntil: state.snoozedUntil ?? null,
      judgeEnabled: enabled,
      persona,
      personas: personaChoices(),
      health,
    }
  }
  // Pause = 30-min quiet (same as the "30분 조용히" toast); resume = clear the snooze by
  // setting its expiry to now. Both reuse the gauge's snooze action; no-op with no goal.
  if (message?.type === "pause" || message?.type === "resume") {
    const goal = await getGoal()
    if (goal) {
      const now = Date.now()
      const until = message.type === "pause" ? now + 30 * 60_000 : now
      await dispatch({ type: "snooze", until, ts: now }, goal)
    }
    return { ok: Boolean(goal) }
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
    return await applySettingsPatch(message.settings ?? {})
  }
  if (message?.type === "enable-local-pdf-observation") {
    if (!Number.isSafeInteger(message.sourceTabId)) return { ok: false }
    return await enableLocalPdfObservation(message.sourceTabId as number)
  }
  // User domain lists (options 사이트 pane). set-domain-lists normalizes/dedupes, persists,
  // and refreshes the synchronous privacy gate in this worker; rejected (non-host) entries
  // travel back so the UI can tell the user what was ignored.
  if (message?.type === "get-domain-lists") {
    return await getDomainLists()
  }
  if (message?.type === "set-domain-lists") {
    return await setDomainLists(message.lists ?? {})
  }
  if (message?.type === "delete-all-data") {
    // Wipe activity data (gauge, history, learned vectors, events, observations, log,
    // visit tracker, cached session summary); keep the goal, Ollama config, persona,
    // and settings.
    await dwell.cancel()
    lastObservedKey = null
    await resetState()
    await clearEvents()
    await clearStore(OBS_STORE)
    await clearLog()
    await clearVisits()
    await clearSessionSummary()
    await clearSessionHistory()
    return { ok: true }
  }
  // Provider settings (options AI 판정 pane). Key values only ever travel INTO the
  // worker; responses carry masked keys via toPublicSettings. tier12 picks up every
  // change on its next call through the settings fingerprint — no cache reset needed.
  // Mutations also clear the recorded provider error: the toolbar "!" mark must not
  // keep accusing a config the user just changed.
  if (message?.type === "get-judge-settings") {
    return toPublicSettings(await getJudgeSettings())
  }
  if (message?.type === "connect-provider" && message.provider) {
    return toPublicSettings(await connectProvider(message.provider))
  }
  if (message?.type === "disconnect-provider" && message.provider) {
    await clearProviderHealth()
    return toPublicSettings(await disconnectProvider(message.provider))
  }
  if (message?.type === "add-provider-key" && message.provider) {
    await clearProviderHealth()
    return toPublicSettings(
      await addProviderKey(message.provider, message.name ?? "", message.value ?? ""),
    )
  }
  if (message?.type === "remove-provider-key" && message.provider && message.keyId) {
    await clearProviderHealth()
    return toPublicSettings(await removeProviderKey(message.provider, message.keyId))
  }
  if (message?.type === "set-routes") {
    await clearProviderHealth()
    return toPublicSettings(await setRoutes(message.routes ?? {}))
  }
  if (message?.type === "test-route" && message.tier && message.provider) {
    return await testRoute(message.tier, message.provider, message.model ?? "")
  }
  if (message?.type === "get-usage") {
    return { rows: await getUsage(message.days ?? 1) }
  }
  if (message?.type === "end-session") {
    const goal = await getGoal()
    const now = Date.now()
    // No active session (double-click, stale popup): just hand back the cached summary.
    if (!goal) return { summary: await getSessionSummary(now) }
    await dwell.cancel() // a pending judge must not race the snapshot
    // Snapshot BEFORE the reset below — resetState's clearHistory wipes the nag log and
    // the tracker is cleared with it. The recap generator captured the stats by value and
    // writes back under an epoch+pending guard, so the reset can't corrupt it either.
    const summary = await finalizeSession(goal, now)
    void generateSummaryComment(summary)
    await setGoal("", null)
    await resetState()
    await clearVisits()
    lastObservedKey = null
    clearBadge()
    logEvent("goal", { text: null, minutes: null, revision: null })
    logEvent("session-end", {
      epoch: summary.epoch,
      pages_total: summary.stats.pagesTotal,
      pages_ok: summary.stats.pagesOk,
      valid_ms: summary.stats.validMs,
    })
    void ensureHeartbeat()
    return { summary }
  }
  if (message?.type === "get-session-summary") {
    return { summary: await getSessionSummary(Date.now()) }
  }
  if (message?.type === "dismiss-session-summary") {
    await dismissSessionSummary()
    return { ok: true }
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
    if (!goal || previous?.epoch !== goal.epoch) {
      await resetState()
      await clearVisits() // stale dwell aggregates must not bleed into the next session
      // A fresh session supersedes the previous session's cached summary; a plain clear
      // (goal null) keeps it so the summary survives until a new goal starts.
      if (goal) await clearSessionSummary()
    }
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
        // The active tab is re-queried at click time — a notification can outlive the nagged
        // page, so the tab may now be a sensitive page. Those must never enter the klog,
        // gauge events, or session visits: skip the whole recovery, same as observe().
        // A notification-button click can wake a fresh worker, so make sure the user lists
        // are loaded before the drop gate below runs.
        await initDomainLists()
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        const descriptor = tab?.url ? describeObservableUrl(tab.url) : null
        const permitted =
          descriptor?.kind === "local_pdf"
            ? (await getSettings()).observeLocalPdfs
            : descriptor?.kind === "web" && !!tab?.url && !shouldDropUrl(tab.url)
        // Title ingress that bypasses observe() — clamp here too.
        const tabTitle = truncateCodePoints(tab?.title ?? "", TITLE_MAX_CHARS)
        if (descriptor && permitted) {
          const { pageKey, urlHost } = descriptor
          klog(`related → OK recover ${pageKey}`)
          await dispatch({ type: "nav", pageKey, verdict: "OK", ts: now }, goal)
          // The user override also flips the page in the session-summary tracker (open a timed
          // interval only if present — a notification-button click can arrive with Chrome unfocused).
          const present = await browserPresent()
          void noteVerdict(pageKey, tabTitle, urlHost, "OK", now, goal.epoch, present)
          // Learn: add this page's embedding as a goal exemplar so this class of page
          // stops drifting at Tier-0 (the user-taught relevance loop).
          if (tabTitle && tab?.url) {
            try {
              await addExemplar(await embedText(tabTitle))
              logEvent("exemplar", { pageKey, title: tabTitle })
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

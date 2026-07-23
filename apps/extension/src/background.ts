import { extractPageExcerpt } from "./content/readabilityExtract"
import { showKibitzerToast } from "./content/toastOverlay"
import {
  FeedbackKind,
  GoalInfo,
  PageInfo,
  PageExcerpt,
  PipelineResult,
  getCurrentSession,
  getLatestObservation,
  getSettings,
  getSessionState,
  postBrowserNav,
  postDeliveryReport,
  postFeedback,
  postObservationContent,
  postObservationExcerpt,
  postObservationPresence,
  setGoal,
  urlPathHashFor,
} from "./lib/api"
import { createBadgeRefresher } from "./lib/badgeRefresh"
import { shouldDropUrl } from "./lib/domainFilter"
import { D7ReviewScheduler, isD7ReviewAlarmName } from "./lib/d7ReviewScheduler"
import {
  GAUGE_SHADOW_STORAGE_KEY,
  GaugeShadowController,
} from "./lib/gaugeShadow"
import type { GaugeShadowSnapshot } from "./lib/gaugeShadow"
import {
  ExplorationResponseKind,
  ExplorationVerdict,
  prependExplorationHistory,
  updateExplorationHistory,
  updateExplorationHistoryByObservationId,
} from "./lib/history"
import {
  DWELL_RECORD_VERSION,
  DwellOutcome,
  DwellRecord,
  ObservationDwellRecord,
  PersistentDwellScheduler,
  Tier2DwellRecord,
} from "./lib/persistentDwell"

const DEFAULT_OBSERVATION_DWELL_MS = 5000
const DEFAULT_TIER2_DWELL_MS = 10000
const EXCERPT_LIMIT = 3500
const NOTIFICATION_ICON = "icons/icon-128.png"
const BADGE_ALARM = "kibitzer-badge-refresh"
const D7_HEARTBEAT_ALARM = "kibitzer-d7-heartbeat"
const TOAST_AUTO_DISMISS_MS = 25000
const TOAST_CELEBRATION_AUTO_DISMISS_MS = 9000
const TOAST_REDISPLAY_WINDOW_MS = 60000
// Chrome notifications support at most 2 action buttons; creating with 3 throws
// and the notification never appears. "accepted" maps to clicking the body.
const NOTIFICATION_BUTTONS: FeedbackKind[] = ["related", "break"]
const FEEDBACK_BUTTON_TITLES: Record<FeedbackKind, string> = {
  related: "목표와 관련 있어요",
  accepted: "잘 잡았어요",
  snooze: "30분 조용히",
  break: "5분만",
}
type ToastKind = "intervention" | "celebration"

interface PendingToast {
  notificationId: string
  kind: ToastKind
  message: string
  contextLabel: string | null
  interventionId?: string
  observationId: string
  createdAt: number
  expiresAt: number
  displayToken: number
  deliveryReported: boolean
  autoDismissMs: number
}

interface RuntimeMessage {
  type?: string
  tabId?: number
  url?: string
  rawGoalText?: string
  availableTimeMinutes?: number | null
  notificationId?: string
  kind?: string
  displayToken?: number
  observationId?: string
  verdict?: ExplorationVerdict
}

interface ActiveD7Observation {
  observationId: string
  url: string
  urlPathHash: string
  contentStored: boolean
  contentRetryAttempted: boolean
}

interface ActivePageAttention {
  version: 1
  tabId: number
  url: string
  startedAt: number
}

let nextToastDisplayToken = 0
const latestObservationTokens = new Map<number, string>()
const pendingToasts = new Map<string, PendingToast>()
const activeD7Observations = new Map<number, ActiveD7Observation>()
let goalObservationTail: Promise<void> = Promise.resolve()
let gaugeShadowWorkTail: Promise<void> = Promise.resolve()
const d7ReviewScheduler = new D7ReviewScheduler(async (observationId) => {
  await ensureD7ObservationsRestored()
  if (![...activeD7Observations.values()].some((item) => item.observationId === observationId)) return
  await heartbeatD7Observation()
})

// MV3 tears the service worker down between heartbeat alarms. Without a
// storage.session copy, every alarm wakes an empty map and takes the
// zero-credit "active" recovery path (stalling the server clocks) and
// re-captures page content each minute.
const D7_TRACKING_STORAGE_KEY = "d7ActiveObservations"
const ACTIVE_PAGE_ATTENTION_PREFIX = "kibitzer:active-page-attention:"
let d7ObservationsRestorePromise: Promise<void> | null = null
let d7ObservationsPersistTail: Promise<void> = Promise.resolve()

interface GaugeShadowContext {
  sessionId: string
  goalMinutes: number | null
}

const gaugeShadow = new GaugeShadowController({
  async load() {
    const data = await chrome.storage.session.get(GAUGE_SHADOW_STORAGE_KEY)
    return data[GAUGE_SHADOW_STORAGE_KEY]
  },
  async save(snapshot) {
    await chrome.storage.session.set({ [GAUGE_SHADOW_STORAGE_KEY]: snapshot })
  },
  async clear() {
    await chrome.storage.session.remove(GAUGE_SHADOW_STORAGE_KEY)
  },
})
let gaugeShadowContext: GaugeShadowContext | null = null

function runGaugeShadowWork<T>(task: () => Promise<T>): Promise<T> {
  const result = gaugeShadowWorkTail.then(task, task)
  gaugeShadowWorkTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function runGaugeShadowSafely(task: () => Promise<void>): Promise<void> {
  try {
    await runGaugeShadowWork(task)
  } catch (error) {
    // Shadow diagnostics must never interrupt the shipping controller path.
    console.warn("kibitzer: gauge shadow update failed", error)
  }
}

async function ensureGaugeShadowContext(): Promise<GaugeShadowContext | null> {
  if (gaugeShadowContext) return gaugeShadowContext
  const current = await getCurrentSession()
  if (!current?.session.active || !current.goal) return null
  gaugeShadowContext = {
    sessionId: current.session.id,
    goalMinutes: current.goal.available_time_minutes ?? null,
  }
  await gaugeShadow.ensureSession(
    gaugeShadowContext.sessionId,
    gaugeShadowContext.goalMinutes,
    Date.now(),
  )
  return gaugeShadowContext
}

async function resetGaugeShadow(goal: GoalInfo): Promise<void> {
  gaugeShadowContext = {
    sessionId: goal.session_id,
    goalMinutes: goal.available_time_minutes ?? null,
  }
  await gaugeShadow.ensureSession(
    gaugeShadowContext.sessionId,
    gaugeShadowContext.goalMinutes,
    Date.now(),
    true,
  )
}

async function clearGaugeShadow(): Promise<void> {
  gaugeShadowContext = null
  await gaugeShadow.clear()
}

async function currentGaugeShadowSnapshot(): Promise<GaugeShadowSnapshot | null> {
  const context = await ensureGaugeShadowContext()
  if (!context) return null
  return gaugeShadow.snapshot(context.sessionId)
}

async function recordGaugeShadowPresence(
  kind: "active" | "heartbeat" | "inactive",
): Promise<void> {
  await runGaugeShadowSafely(async () => {
    if (!(await ensureGaugeShadowContext())) return
    const ts = Date.now()
    // Both leaving and resuming rebase the clock. This keeps inactive wall time
    // out of the reducer even though GaugeState intentionally has no active flag.
    await gaugeShadow.dispatch(
      kind === "heartbeat"
        ? { type: "heartbeat", ts }
        : { type: "inactive", ts },
    )
  })
}

async function recordGaugeShadowNav(
  url: string,
  result: PipelineResult | null,
): Promise<void> {
  const verdict = result?.verdict
  if (verdict !== "OK" && verdict !== "DRIFT") return
  await runGaugeShadowSafely(async () => {
    if (!(await ensureGaugeShadowContext())) return
    const page = new URL(url)
    const pathHash = await urlPathHashFor(url)
    await gaugeShadow.dispatch({
      type: "nav",
      pageKey: `${page.hostname}:${pathHash}`,
      verdict,
      ts: Date.now(),
    })
  })
}

function ensureD7ObservationsRestored(): Promise<void> {
  if (!d7ObservationsRestorePromise) {
    d7ObservationsRestorePromise = (async () => {
      try {
        const data = await chrome.storage.session.get(D7_TRACKING_STORAGE_KEY)
        const entries = data?.[D7_TRACKING_STORAGE_KEY] as Array<[number, ActiveD7Observation]> | undefined
        if (!Array.isArray(entries)) return
        for (const [tabId, tracked] of entries) {
          if (!activeD7Observations.has(tabId)) activeD7Observations.set(tabId, tracked)
        }
      } catch {
        // Start empty and allow a later event to retry transient storage failures.
        d7ObservationsRestorePromise = null
      }
    })()
  }
  return d7ObservationsRestorePromise
}

function persistD7Observations(): Promise<void> {
  const entries = [...activeD7Observations.entries()]
  const write = d7ObservationsPersistTail.then(() =>
    chrome.storage.session.set({ [D7_TRACKING_STORAGE_KEY]: entries }),
  )
  d7ObservationsPersistTail = write.catch(() => undefined)
  return d7ObservationsPersistTail
}

const dwellScheduler = new PersistentDwellScheduler(processDwellRecord, async (record) => {
  await finishHistoryEntry(record.historyId)
})

function runGoalObservationTask<T>(task: () => Promise<T>): Promise<T> {
  const result = goalObservationTail.then(task, task)
  goalObservationTail = result.then(() => undefined, () => undefined)
  return result
}

function activePageAttentionKey(tabId: number): string {
  return `${ACTIVE_PAGE_ATTENTION_PREFIX}${tabId}`
}

async function loadActivePageAttention(tabId: number): Promise<ActivePageAttention | null> {
  const key = activePageAttentionKey(tabId)
  const stored = (await chrome.storage.session.get(key))[key] as Partial<ActivePageAttention> | undefined
  if (
    stored?.version !== 1
    || stored.tabId !== tabId
    || typeof stored.url !== "string"
    || typeof stored.startedAt !== "number"
    || !Number.isFinite(stored.startedAt)
  ) return null
  return stored as ActivePageAttention
}

async function saveActivePageAttention(attention: ActivePageAttention): Promise<void> {
  await chrome.storage.session.set({ [activePageAttentionKey(attention.tabId)]: attention })
}

async function scheduleTabObservation(
  tabId: number,
  observedUrl?: string,
  preservedStartedAt?: number,
): Promise<boolean> {
  void deactivateD7Observation(tabId)
  const token = makeObservationToken()
  const startedAt = preservedStartedAt ?? Date.now()
  latestObservationTokens.set(tabId, token)
  await dwellScheduler.startNavigation(tabId, token)
  if (latestObservationTokens.get(tabId) !== token) return false

  const tab = await getTab(tabId)
  const url = observedUrl ?? tab?.url
  if (!tab?.active || !url || tab.url !== url || shouldDropUrl(url)) return false
  await saveActivePageAttention({ version: 1, tabId, url, startedAt })
  const dwell = await loadDwellSettings()
  if (latestObservationTokens.get(tabId) !== token) return false
  const currentTab = await getTab(tabId)
  if (!currentTab?.active || currentTab.url !== url) return false

  const historyId = makeHistoryId(token)
  await prependExplorationHistory({
    id: historyId,
    tabId,
    url,
    title: currentTab.title ?? "",
    startedAt,
    observationDwellMs: dwell.observationDwellMs,
    tier2DwellMs: dwell.tier2DwellMs,
  })
  if (latestObservationTokens.get(tabId) !== token) {
    await finishHistoryEntry(historyId)
    return false
  }

  const record: ObservationDwellRecord = {
    version: DWELL_RECORD_VERSION,
    stage: "observation",
    token,
    tabId,
    url,
    startedAt,
    dueAt: startedAt + dwell.observationDwellMs,
    historyId,
    tier2DwellMs: dwell.tier2DwellMs,
  }
  if (!(await dwellScheduler.schedule(record))) {
    await finishHistoryEntry(historyId)
    return false
  }
  return true
}

async function scheduleCurrentPageForReadyGoal(): Promise<{ ok: boolean; immediate: boolean }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (tab?.id === undefined || !tab.url) return { ok: false, immediate: false }
  const attention = await loadActivePageAttention(tab.id)
  const startedAt = attention?.url === tab.url ? attention.startedAt : Date.now()
  const scheduled = await scheduleTabObservation(tab.id, tab.url, startedAt)
  const record = scheduled ? await dwellScheduler.currentRecordForPage(tab.id, tab.url) : null
  return { ok: scheduled, immediate: Boolean(record && record.dueAt <= Date.now()) }
}

async function setGoalAndScheduleCurrentPage(
  rawGoalText: string,
  availableTimeMinutes: number | null,
): Promise<{ ok: boolean; goal?: GoalInfo; immediate: boolean }> {
  return runGoalObservationTask(async () => {
    const goal = await setGoal(rawGoalText, availableTimeMinutes, true)
    if (!goal) return { ok: false, immediate: false }
    await runGaugeShadowSafely(() => resetGaugeShadow(goal))
    const scheduled = await scheduleCurrentPageForReadyGoal()
    return { ok: true, goal, immediate: scheduled.immediate }
  })
}

async function currentPageProcessingStage(
  tabId: number,
  url: string,
): Promise<"tier0" | null> {
  const record = await dwellScheduler.currentRecordForPage(tabId, url)
  if (!record || record.stage !== "observation") return null
  return record.dueAt <= Date.now() ? "tier0" : null
}

function makeObservationToken(): string {
  return `nav_${crypto.randomUUID().replaceAll("-", "")}`
}

function makeHistoryId(token: string): string {
  return `hist_${Date.now()}_${token.slice(-8)}`
}

interface DwellTiming {
  observationDwellMs: number
  tier2DwellMs: number
}

async function loadDwellSettings(): Promise<DwellTiming> {
  try {
    const settings = await getSettings()
    return {
      observationDwellMs: (settings?.dwell.observation_seconds ?? 5) * 1000,
      tier2DwellMs: (settings?.dwell.tier2_seconds ?? 10) * 1000,
    }
  } catch {
    return {
      observationDwellMs: DEFAULT_OBSERVATION_DWELL_MS,
      tier2DwellMs: DEFAULT_TIER2_DWELL_MS,
    }
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

function cancelInactiveTabWork(activeTabId: number): void {
  for (const tabId of latestObservationTokens.keys()) {
    if (tabId === activeTabId) continue
    latestObservationTokens.delete(tabId)
  }
  void dwellScheduler.cancelOtherTabs(activeTabId)
  void deactivateInactiveD7Observations(activeTabId)
}

async function deactivateInactiveD7Observations(activeTabId: number): Promise<void> {
  await ensureD7ObservationsRestored()
  for (const tabId of activeD7Observations.keys()) {
    if (tabId !== activeTabId) void deactivateD7Observation(tabId)
  }
}

async function finishHistoryEntry(historyId: string | undefined): Promise<void> {
  if (!historyId) return
  await updateExplorationHistory(historyId, { endedAt: Date.now() })
}

async function updateHistoryWithPipelineResult(
  historyId: string | undefined,
  result: PipelineResult | null,
  title: string,
): Promise<void> {
  if (!historyId) return
  const patch: {
    endedAt: number
    title?: string
    observationId?: string
    verdict?: ExplorationVerdict
    responseKind?: ExplorationResponseKind
  } = {
    endedAt: Date.now(),
  }
  if (title.trim()) patch.title = title
  if (result?.observation_id) patch.observationId = result.observation_id
  if (result?.verdict === "OK" || result?.verdict === "DRIFT") patch.verdict = result.verdict
  const responseKind = historyResponseKind(result)
  if (responseKind) patch.responseKind = responseKind
  await updateExplorationHistory(historyId, patch)
}

async function updateHistoryResponse(
  historyId: string | undefined,
  result: PipelineResult | null,
): Promise<void> {
  if (!historyId) return
  const responseKind = historyResponseKind(result)
  if (!responseKind) return
  await updateExplorationHistory(historyId, { responseKind })
}

function historyResponseKind(result: PipelineResult | null): ExplorationResponseKind | undefined {
  if (result?.action !== "notify") return undefined
  if (result.kind === "celebration") return "celebration"
  if (result.kind === "intervention" || result.intervention_id) return "intervention"
  return undefined
}

function newPresenceEventId(): string {
  return crypto.randomUUID?.() ?? `d7_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function captureD7ContentAndActivate(tabId: number, observationId: string, url: string): Promise<void> {
  await ensureD7ObservationsRestored()
  if (!(await tabStillActivelyViewed(tabId, url))) return
  const pathHash = await urlPathHashFor(url).catch(() => null)
  if (!pathHash) return
  const tracked: ActiveD7Observation = {
    observationId,
    url,
    urlPathHash: pathHash,
    contentStored: false,
    contentRetryAttempted: false,
  }
  await captureD7Content(tabId, tracked)
  if (!(await tabStillActivelyViewed(tabId, url))) return
  activeD7Observations.set(tabId, tracked)
  await persistD7Observations()
  await sendD7Presence(tabId, tracked, "active")
}

async function captureD7Content(tabId: number, tracked: ActiveD7Observation): Promise<void> {
  const excerpt = await extractFromTab(tabId)
  if (!excerpt || !(await tabStillActivelyViewed(tabId, tracked.url))) return
  const result = await postObservationContent(tracked.observationId, excerpt)
  tracked.contentStored = Boolean(result?.stored)
}

async function sendD7Presence(
  tabId: number,
  tracked: ActiveD7Observation,
  kind: "active" | "heartbeat" | "inactive",
): Promise<void> {
  if (kind !== "inactive" && !(await tabStillActivelyViewed(tabId, tracked.url))) return
  await recordGaugeShadowPresence(kind)
  const result = await postObservationPresence(tracked.observationId, {
    event_id: newPresenceEventId(),
    kind,
    tab_id: tabId,
    url_path_hash: tracked.urlPathHash,
  })
  await recordGaugeShadowNav(tracked.url, result)
  if (
    kind !== "inactive" &&
    result?.next_review_check_seconds &&
    activeD7Observations.get(tabId)?.observationId === tracked.observationId
  ) {
    await d7ReviewScheduler.schedule(tracked.observationId, result.next_review_check_seconds)
    if (activeD7Observations.get(tabId)?.observationId !== tracked.observationId) {
      await d7ReviewScheduler.clear(tracked.observationId)
    }
  }
  if (kind !== "inactive" && result?.action === "notify" && result.message) {
    if (await tabStillActivelyViewed(tabId, tracked.url)) await showNotification(result, tabId)
  }
}

async function deactivateD7Observation(tabId: number): Promise<void> {
  await ensureD7ObservationsRestored()
  const tracked = activeD7Observations.get(tabId)
  if (!tracked) return
  activeD7Observations.delete(tabId)
  await d7ReviewScheduler.clear(tracked.observationId)
  await persistD7Observations()
  await sendD7Presence(tabId, tracked, "inactive")
}

async function heartbeatD7Observation(forceActive = false): Promise<void> {
  await ensureD7ObservationsRestored()
  if (!(await browserPresenceIsActive())) {
    await deactivateAllD7Observations()
    return
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const tab = tabs[0]
  if (tab?.id === undefined || !tab.url) return
  let tracked = activeD7Observations.get(tab.id)
  let kind: "active" | "heartbeat" = forceActive ? "active" : "heartbeat"
  if (!tracked || tracked.url !== tab.url) {
    const latest = await getLatestObservation(tab.id, tab.url)
    const pathHash = await urlPathHashFor(tab.url).catch(() => null)
    if (!latest || !pathHash) return
    tracked = {
      observationId: latest.observation_id,
      url: tab.url,
      urlPathHash: pathHash,
      contentStored: false,
      contentRetryAttempted: false,
    }
    activeD7Observations.set(tab.id, tracked)
    await persistD7Observations()
    kind = "active"
  }
  if (!tracked.contentStored && !tracked.contentRetryAttempted) {
    tracked.contentRetryAttempted = true
    await captureD7Content(tab.id, tracked)
    await persistD7Observations()
  }
  await sendD7Presence(tab.id, tracked, kind)
}

async function deactivateAllD7Observations(): Promise<void> {
  await ensureD7ObservationsRestored()
  await Promise.all([...activeD7Observations.keys()].map((tabId) => deactivateD7Observation(tabId)))
}

async function browserPresenceIsActive(): Promise<boolean> {
  try {
    const [window, idleState] = await Promise.all([
      chrome.windows.getLastFocused(),
      chrome.idle.queryState(60),
    ])
    return Boolean(window.focused && idleState === "active")
  } catch {
    // D7 intentionally prefers a missed dwell over a false-positive clock.
    return false
  }
}

async function tabStillActivelyViewed(tabId: number, url: string): Promise<boolean> {
  try {
    const [tab, window, idleState] = await Promise.all([
      getTab(tabId),
      chrome.windows.getLastFocused(),
      chrome.idle.queryState(60),
    ])
    return Boolean(
      tab?.active
      && tab.url === url
      && window.focused
      && tab.windowId === window.id
      && idleState === "active"
    )
  } catch {
    return false
  }
}

async function processDwellRecord(record: DwellRecord): Promise<DwellOutcome> {
  return record.stage === "observation"
    ? processObservationDwell(record)
    : processTier2Dwell(record)
}

async function processObservationDwell(record: ObservationDwellRecord): Promise<DwellOutcome> {
  const tab = await getTab(record.tabId)
  if (!tab?.active || tab.url !== record.url || shouldDropUrl(record.url)) return "cancel"

  const attempt = await runGoalObservationTask(async () => {
    const current = await dwellScheduler.currentRecordForPage(record.tabId, record.url)
    if (current?.stage !== "observation" || current.token !== record.token) {
      return { cancelled: true, result: null }
    }
    const result = await postBrowserNav(
      { url: record.url, title: tab.title ?? "", tab_id: tab.id },
      record.token,
    )
    return { cancelled: false, result }
  })
  if (attempt.cancelled) return "cancel"
  const result = attempt.result
  if (!result) return "retry"
  await recordGaugeShadowNav(record.url, result)
  await updateHistoryWithPipelineResult(record.historyId, result, tab.title ?? "")
  if (result.observation_id) {
    await captureD7ContentAndActivate(record.tabId, result.observation_id, record.url)
  }

  if (
    result.action === "request_excerpt" &&
    result.observation_id &&
    result.candidate_id
  ) {
    const tier2: Tier2DwellRecord = {
      version: DWELL_RECORD_VERSION,
      stage: "tier2",
      token: record.token,
      tabId: record.tabId,
      url: record.url,
      dueAt: record.startedAt + record.tier2DwellMs,
      historyId: record.historyId,
      observationId: result.observation_id,
    }
    if (!(await dwellScheduler.schedule(tier2))) return "cancel"
  } else if (
    result.action === "notify" &&
    result.kind === "celebration" &&
    result.message &&
    (await tabStillOnObservedPage(record.tabId, record.url))
  ) {
    await showNotification(result, record.tabId)
  }
  void refreshBadge()
  return "complete"
}

async function processTier2Dwell(record: Tier2DwellRecord): Promise<DwellOutcome> {
  if (!(await tabStillOnObservedPage(record.tabId, record.url))) return "cancel"
  const excerpt = await extractFromTab(record.tabId)
  if (!excerpt) return "cancel"
  if (!(await tabStillOnObservedPage(record.tabId, record.url))) return "cancel"

  const result = await postObservationExcerpt(record.observationId, excerpt)
  if (!result) return "retry"
  await recordGaugeShadowNav(record.url, result)
  await updateHistoryResponse(record.historyId, result)
  if (
    result.action === "notify" &&
    result.message &&
    (await tabStillOnObservedPage(record.tabId, record.url))
  ) {
    await showNotification(result, record.tabId)
  }
  void refreshBadge()
  return "complete"
}

async function tabStillOnObservedPage(tabId: number, url: string): Promise<boolean> {
  const tab = await getTab(tabId)
  return Boolean(tab?.active && tab.url === url)
}

async function extractFromTab(tabId: number): Promise<PageExcerpt | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageExcerpt,
      args: [EXCERPT_LIMIT],
    })
    return results[0]?.result ?? null
  } catch {
    return null
  }
}

async function showNotification(result: PipelineResult, tabId?: number): Promise<void> {
  if (!result.observation_id || !result.message) return
  const kind: ToastKind = result.kind === "celebration" ? "celebration" : "intervention"
  const celebration = kind === "celebration"
  if (!celebration && !result.intervention_id) return
  const silent = (result as PipelineResult & { silent?: boolean }).silent === true
  if (silent) {
    if (result.intervention_id) void postDeliveryReport(result.intervention_id, true)
    void refreshBadge()
    return
  }
  const notificationId = celebration
    ? `kibitzer:celebration:${result.observation_id}`
    : `kibitzer:${result.intervention_id}`
  const toast = rememberPendingToast(result, notificationId, kind)
  if (!toast) return

  if (tabId !== undefined && (await displayPendingToast(toast, tabId, true))) {
    void refreshBadge()
    return
  }

  await showSystemNotificationFallback(toast)
  void refreshBadge()
}

function rememberPendingToast(
  result: PipelineResult,
  notificationId: string,
  kind: ToastKind,
): PendingToast | null {
  if (!result.observation_id || !result.message) return null
  const now = Date.now()
  const autoDismissMs = kind === "celebration" ? TOAST_CELEBRATION_AUTO_DISMISS_MS : TOAST_AUTO_DISMISS_MS
  const toast: PendingToast = {
    notificationId,
    kind,
    message: result.message,
    contextLabel: pageLabel(result.page) ?? null,
    interventionId: result.intervention_id ?? undefined,
    observationId: result.observation_id,
    createdAt: now,
    expiresAt: now + Math.max(autoDismissMs, TOAST_REDISPLAY_WINDOW_MS),
    displayToken: 0,
    deliveryReported: false,
    autoDismissMs,
  }
  pendingToasts.set(notificationId, toast)
  return toast
}

async function displayPendingToast(toast: PendingToast, tabId: number, logFailure = false): Promise<boolean> {
  const tab = await getTab(tabId)
  if (!tab?.active || !tab.url || !isInjectablePageUrl(tab.url)) return false

  const displayToken = ++nextToastDisplayToken
  toast.displayToken = displayToken

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showKibitzerToast,
      args: [
        {
          notificationId: toast.notificationId,
          displayToken,
          message: toast.message,
          contextLabel: toast.contextLabel,
          autoDismissMs: toast.autoDismissMs,
          kind: toast.kind,
        },
      ],
    })
    toast.expiresAt = Date.now() + Math.max(toast.autoDismissMs, TOAST_REDISPLAY_WINDOW_MS)
    markToastPresented(toast)
    return true
  } catch (error) {
    if (logFailure) {
      // Non-injectable surface (chrome:// pages, web store, PDF viewer) falls
      // back on first delivery and stays pending for a later active web page.
      console.warn("kibitzer: in-page toast failed, falling back", error)
    }
    return false
  }
}

function isInjectablePageUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return !shouldDropUrl(rawUrl)
}

function markToastPresented(toast: PendingToast): void {
  if (toast.deliveryReported) return
  toast.deliveryReported = true
  if (toast.kind === "intervention" && toast.interventionId) {
    void postDeliveryReport(toast.interventionId, true)
    void playNotificationSound()
    return
  }
  if (toast.kind === "celebration") {
    void playNotificationSound("celebrate")
  }
}

async function showSystemNotificationFallback(toast: PendingToast): Promise<boolean> {
  try {
    const options: chrome.notifications.NotificationOptions<true> = {
      type: "basic",
      iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
      title: "Kibitzer",
      message: toast.message,
      contextMessage: toast.contextLabel ?? undefined,
      priority: toast.kind === "celebration" ? 0 : 2,
      requireInteraction: toast.kind !== "celebration",
    }
    if (toast.kind !== "celebration") {
      options.buttons = NOTIFICATION_BUTTONS.map((buttonKind) => ({ title: FEEDBACK_BUTTON_TITLES[buttonKind] }))
    }
    await chrome.notifications.create(toast.notificationId, {
      ...options,
    })
    markToastPresented(toast)
    return true
  } catch (error) {
    console.error("kibitzer: notification create failed", error)
    return false
  }
}

function latestPendingToast(): PendingToast | null {
  pruneExpiredPendingToasts()
  let latest: PendingToast | null = null
  for (const toast of pendingToasts.values()) {
    if (!latest || toast.createdAt > latest.createdAt) {
      latest = toast
    }
  }
  return latest
}

function pruneExpiredPendingToasts(): void {
  const now = Date.now()
  for (const [notificationId, toast] of pendingToasts) {
    if (toast.expiresAt <= now) {
      pendingToasts.delete(notificationId)
    }
  }
}

async function redisplayLatestPendingToast(tabId: number): Promise<void> {
  const toast = latestPendingToast()
  if (!toast) return
  await displayPendingToast(toast, tabId)
}

async function dismissPendingToast(notificationId: string, displayToken?: number): Promise<void> {
  const toast = pendingToasts.get(notificationId)
  if (!toast) return
  if (displayToken === undefined || displayToken !== toast.displayToken) return
  pendingToasts.delete(notificationId)
  await clearSystemNotification(notificationId)
  void refreshBadge()
}

async function clearSystemNotification(notificationId: string): Promise<void> {
  try {
    await chrome.notifications.clear(notificationId)
  } catch {
    // The in-page path usually has no Chrome notification to clear.
  }
}

function isFeedbackKind(kind: string | undefined): kind is FeedbackKind {
  return kind === "related" || kind === "accepted" || kind === "snooze" || kind === "break"
}

function pageLabel(page: PageInfo | null | undefined): string | undefined {
  const host = page?.host?.trim()
  const title = page?.title?.trim()
  if (host && title) return `${host} - ${title}`
  return title || host || undefined
}

async function playNotificationSound(sound: "ding" | "celebrate" = "ding"): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    })
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: "Play a short chime when a drift notification is shown.",
      })
    }
    await chrome.runtime.sendMessage({ type: "kibitzer:play-sound", sound })
  } catch (error) {
    console.error("kibitzer: notification sound failed", error)
  }
}

type BadgeStatus = "unreachable" | "no_goal" | "pending" | "snoozed" | "tracking"

// Status → small top-right dot colour drawn onto the icon (null = clean icon, no dot).
// Replaces Chrome's native text badge, whose size/position we cannot control and
// which covered too much of the mark.
const STATUS_DOT_COLOR: Record<BadgeStatus, string | null> = {
  unreachable: "#5f5e5a",
  no_goal: "#ba7517",
  pending: "#a32d2d",
  snoozed: "#185fa5",
  tracking: null,
}

// Native-badge text, used only as a fallback if custom icon drawing ever fails.
const STATUS_BADGE_FALLBACK: Record<BadgeStatus, { text: string; color: string }> = {
  unreachable: { text: "?", color: "#5f5e5a" },
  no_goal: { text: "!", color: "#ba7517" },
  pending: { text: "1", color: "#a32d2d" },
  snoozed: { text: "z", color: "#185fa5" },
  tracking: { text: "", color: "#5f5e5a" },
}

const ACTION_ICON_SIZES = [16, 32] as const
let baseIconBitmaps: Map<number, ImageBitmap> | null = null

async function loadBaseIconBitmaps(): Promise<Map<number, ImageBitmap>> {
  if (baseIconBitmaps) return baseIconBitmaps
  const map = new Map<number, ImageBitmap>()
  for (const size of ACTION_ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob()
    map.set(size, await createImageBitmap(blob))
  }
  baseIconBitmaps = map
  return map
}

function drawStatusDot(ctx: OffscreenCanvasRenderingContext2D, size: number, color: string): void {
  const r = Math.max(2.4, size * 0.16)
  const inset = size * 0.0

  const cx = size - r - inset
  const cy = r + inset

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

async function applyStatusIcon(status: BadgeStatus): Promise<void> {
  const color = STATUS_DOT_COLOR[status]
  try {
    const bases = await loadBaseIconBitmaps()
    const imageData: Record<number, ImageData> = {}
    for (const size of ACTION_ICON_SIZES) {
      const canvas = new OffscreenCanvas(size, size)
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("no 2d context")
      ctx.clearRect(0, 0, size, size)
      const base = bases.get(size)
      if (base) ctx.drawImage(base, 0, 0, size, size)
      if (color) drawStatusDot(ctx, size, color)
      imageData[size] = ctx.getImageData(0, 0, size, size)
    }
    await chrome.action.setIcon({ imageData })
    await chrome.action.setBadgeText({ text: "" }) // ensure the native badge stays off
  } catch (error) {
    console.error("kibitzer: status icon draw failed, using text badge", error)
    const fallback = STATUS_BADGE_FALLBACK[status]
    await chrome.action.setBadgeText({ text: fallback.text })
    if (fallback.text) await chrome.action.setBadgeBackgroundColor({ color: fallback.color })
  }
}

async function computeBadgeStatus(): Promise<BadgeStatus> {
  const result = await getSessionState()
  if (result.kind === "unreachable") return "unreachable"
  if (result.kind === "no_session" || !result.state.has_goal) return "no_goal"
  if (result.state.pending_intervention) return "pending"
  if (result.state.tracking === "snoozed") return "snoozed"
  return "tracking"
}

const refreshBadge = createBadgeRefresher(computeBadgeStatus, applyStatusIcon)

async function initBadge(): Promise<void> {
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 })
  await chrome.alarms.create(D7_HEARTBEAT_ALARM, { periodInMinutes: 1 })
  chrome.idle.setDetectionInterval(60)
  await refreshBadge()
}

chrome.runtime.onInstalled.addListener(() => {
  void initBadge()
})

chrome.runtime.onStartup.addListener(() => {
  void initBadge()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) {
    void refreshBadge()
  } else if (alarm.name === D7_HEARTBEAT_ALARM) {
    void heartbeatD7Observation()
  } else if (isD7ReviewAlarmName(alarm.name)) {
    void d7ReviewScheduler.handleAlarm(alarm.name)
  } else {
    void dwellScheduler.handleAlarm(alarm.name)
  }
})

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage | undefined, _sender, sendResponse) => {
    if (message?.type === "kibitzer:get-gauge-shadow") {
      void runGaugeShadowWork(currentGaugeShadowSnapshot).then(
        (snapshot) => sendResponse({ snapshot }),
        () => sendResponse({ snapshot: null }),
      )
      return true
    }
    if (message?.type === "kibitzer:clear-gauge-shadow") {
      void runGaugeShadowWork(clearGaugeShadow).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      )
      return true
    }
    if (
      message?.type === "kibitzer:update-history-verdict" &&
      message.observationId &&
      (message.verdict === "OK" || message.verdict === "DRIFT")
    ) {
      void updateExplorationHistoryByObservationId(message.observationId, {
        userVerdict: message.verdict,
      }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      )
      return true
    }
    if (
      message?.type === "kibitzer:set-goal"
      && typeof message.rawGoalText === "string"
    ) {
      void setGoalAndScheduleCurrentPage(
        message.rawGoalText,
        message.availableTimeMinutes ?? null,
      ).then(
        (result) => sendResponse(result),
        () => sendResponse({ ok: false, immediate: false }),
      )
      return true
    }
    if (
      message?.type === "kibitzer:get-page-processing-stage"
      && typeof message.tabId === "number"
      && typeof message.url === "string"
    ) {
      void currentPageProcessingStage(message.tabId, message.url).then(
        (stage) => sendResponse({ stage }),
        () => sendResponse({ stage: null }),
      )
      return true
    }
    if (message?.type === "kibitzer:refresh-badge") void refreshBadge()
    if (message?.type === "kibitzer:toast-feedback" && message.notificationId) {
      const kind = message.kind
      if (isFeedbackKind(kind)) {
        void submitNotificationFeedback(message.notificationId, kind)
      } else {
        // dismissed / timeout: no feedback signal, just stop tracking it.
        void dismissPendingToast(message.notificationId, message.displayToken)
      }
    }
    return false
  },
)

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  void submitNotificationFeedback(notificationId, NOTIFICATION_BUTTONS[buttonIndex])
})

chrome.notifications.onClicked.addListener((notificationId) => {
  void submitNotificationFeedback(notificationId, "accepted")
})

chrome.notifications.onClosed.addListener((notificationId) => {
  pendingToasts.delete(notificationId)
})

async function submitNotificationFeedback(
  notificationId: string,
  kind: FeedbackKind | undefined,
): Promise<void> {
  const toast = pendingToasts.get(notificationId)
  if (!toast || !kind) return
  if (toast.kind === "intervention" && toast.interventionId) {
    const result = await postFeedback({
      kind,
      intervention_id: toast.interventionId,
      observation_id: toast.observationId,
    })
    if (
      result?.observation_id &&
      (result.verdict === "OK" || result.verdict === "DRIFT")
    ) {
      await updateExplorationHistoryByObservationId(result.observation_id, {
        userVerdict: result.verdict,
      }).catch(() => undefined)
    }
  }
  pendingToasts.delete(notificationId)
  await clearSystemNotification(notificationId)
  void refreshBadge()
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) void scheduleTabObservation(details.tabId, details.url)
})

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    void scheduleTabObservation(details.tabId, details.url)
    void redisplayLatestPendingToast(details.tabId)
  }
})

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) void redisplayLatestPendingToast(details.tabId)
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  cancelInactiveTabWork(activeInfo.tabId)
  void scheduleTabObservation(activeInfo.tabId)
  void redisplayLatestPendingToast(activeInfo.tabId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void deactivateAllD7Observations()
    return
  }
  void heartbeatD7Observation(true)
})

chrome.idle.onStateChanged.addListener((state) => {
  if (state === "active") {
    void heartbeatD7Observation(true)
    return
  }
  void deactivateAllD7Observations()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void deactivateD7Observation(tabId)
  latestObservationTokens.delete(tabId)
  void dwellScheduler.cancelTab(tabId)
  void chrome.storage.session.remove(activePageAttentionKey(tabId))
})

void dwellScheduler.restore()
void refreshBadge()

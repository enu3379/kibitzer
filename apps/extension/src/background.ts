import { extractPageExcerpt } from "./content/readabilityExtract"
import { showKibitzerToast } from "./content/toastOverlay"
import {
  FeedbackKind,
  PageInfo,
  PageExcerpt,
  PipelineResult,
  getLatestObservation,
  getSettings,
  getSessionState,
  postBrowserNav,
  postDeliveryReport,
  postFeedback,
  postObservationContent,
  postObservationExcerpt,
  postObservationPresence,
  urlPathHashFor,
} from "./lib/api"
import { shouldDropUrl } from "./lib/domainFilter"
import {
  ExplorationVerdict,
  prependExplorationHistory,
  updateExplorationHistory,
} from "./lib/history"

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
interface PendingTabObservation {
  token: number
  url: string
  startedAt: number
  timer: number
  historyId?: string
  tier2DwellMs: number
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

interface ActiveD7Observation {
  observationId: string
  url: string
  urlPathHash: string
  contentStored: boolean
  contentRetryAttempted: boolean
}

let nextObservationToken = 0
let nextToastDisplayToken = 0
const pendingTabObservations = new Map<number, PendingTabObservation>()
const pendingToasts = new Map<string, PendingToast>()
const activeD7Observations = new Map<number, ActiveD7Observation>()

// MV3 tears the service worker down between heartbeat alarms. Without a
// storage.session copy, every alarm wakes an empty map and takes the
// zero-credit "active" recovery path (stalling the server clocks) and
// re-captures page content each minute.
const D7_TRACKING_STORAGE_KEY = "d7ActiveObservations"
let d7ObservationsRestored = false

async function ensureD7ObservationsRestored(): Promise<void> {
  if (d7ObservationsRestored) return
  d7ObservationsRestored = true
  try {
    const data = await chrome.storage.session.get(D7_TRACKING_STORAGE_KEY)
    const entries = data?.[D7_TRACKING_STORAGE_KEY] as Array<[number, ActiveD7Observation]> | undefined
    if (!Array.isArray(entries)) return
    for (const [tabId, tracked] of entries) {
      if (!activeD7Observations.has(tabId)) activeD7Observations.set(tabId, tracked)
    }
  } catch {
    // Start empty; the heartbeat recovery path remains the fallback.
  }
}

function persistD7Observations(): void {
  void chrome.storage.session
    .set({ [D7_TRACKING_STORAGE_KEY]: [...activeD7Observations.entries()] })
    .catch(() => undefined)
}

function scheduleTabObservation(tabId: number, observedUrl?: string): void {
  void deactivateD7Observation(tabId)
  clearTabTimer(tabId)
  const token = ++nextObservationToken
  const startedAt = Date.now()
  pendingTabObservations.set(tabId, {
    token,
    url: "",
    startedAt,
    timer: 0,
    tier2DwellMs: DEFAULT_TIER2_DWELL_MS,
  })
  if (observedUrl) {
    void scheduleDwellCheck(tabId, token, observedUrl, startedAt)
    return
  }

  void getTab(tabId).then((tab) => {
    const pending = pendingTabObservations.get(tabId)
    if (!pending || pending.token !== token) return
    if (!tab?.active || !tab.url || shouldDropUrl(tab.url)) {
      pendingTabObservations.delete(tabId)
      return
    }
    void scheduleDwellCheck(tabId, token, tab.url, startedAt)
  })
}

async function scheduleDwellCheck(tabId: number, token: number, url: string, startedAt: number): Promise<void> {
  if (shouldDropUrl(url)) {
    pendingTabObservations.delete(tabId)
    return
  }
  const dwell = await loadDwellSettings()
  const pendingBeforeTab = pendingTabObservations.get(tabId)
  if (!pendingBeforeTab || pendingBeforeTab.token !== token) return
  const tab = await getTab(tabId)
  const pending = pendingTabObservations.get(tabId)
  if (!pending || pending.token !== token) return
  if (!tab?.active) {
    pendingTabObservations.delete(tabId)
    return
  }
  const historyId = makeHistoryId(token)
  await prependExplorationHistory({
    id: historyId,
    tabId,
    url,
    title: tab.url === url ? tab.title ?? "" : "",
    startedAt,
    observationDwellMs: dwell.observationDwellMs,
    tier2DwellMs: dwell.tier2DwellMs,
  })
  const pendingAfterHistory = pendingTabObservations.get(tabId)
  if (!pendingAfterHistory || pendingAfterHistory.token !== token) {
    await finishHistoryEntry(historyId)
    return
  }
  const timer = globalThis.setTimeout(async () => {
    const pending = pendingTabObservations.get(tabId)
    if (!pending || pending.token !== token) return
    pendingTabObservations.delete(tabId)
    const tab = await getTab(tabId)
    if (!tab || !tab.active || tab.url !== url || shouldDropUrl(url)) {
      await finishHistoryEntry(pending.historyId)
      return
    }
    const result = await postBrowserNav({
      url,
      title: tab.title ?? "",
      tab_id: tab.id,
    })
    await updateHistoryWithPipelineResult(pending.historyId, result, tab.title ?? "")
    await handlePipelineResult(tabId, result, {
      url,
      startedAt,
      tier2DwellMs: pending.tier2DwellMs,
    })
    void refreshBadge()
  }, dwell.observationDwellMs)
  pendingTabObservations.set(tabId, {
    token,
    url,
    startedAt,
    timer,
    historyId,
    tier2DwellMs: dwell.tier2DwellMs,
  })
}

function makeHistoryId(token: number): string {
  return `hist_${Date.now()}_${token}`
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

function clearTabTimer(tabId: number): void {
  const pending = pendingTabObservations.get(tabId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingTabObservations.delete(tabId)
  void finishHistoryEntry(pending.historyId)
}

function clearInactiveTabTimers(activeTabId: number): void {
  for (const tabId of pendingTabObservations.keys()) {
    if (tabId !== activeTabId) clearTabTimer(tabId)
  }
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
  const patch: { endedAt: number; title?: string; observationId?: string; verdict?: ExplorationVerdict } = {
    endedAt: Date.now(),
  }
  if (title.trim()) patch.title = title
  if (result?.observation_id) patch.observationId = result.observation_id
  if (result?.verdict === "OK" || result?.verdict === "DRIFT") patch.verdict = result.verdict
  await updateExplorationHistory(historyId, patch)
}

async function handlePipelineResult(
  tabId: number,
  result: PipelineResult | null,
  observation: { url: string; startedAt: number; tier2DwellMs: number },
): Promise<void> {
  if (!result?.observation_id) return
  await captureD7ContentAndActivate(tabId, result.observation_id, observation.url)
  // Celebrations arrive directly on the browser-nav response (no excerpt round
  // trip). Show only if the user is still on the page they returned to.
  if (result.action === "notify" && result.kind === "celebration" && result.message) {
    if (!(await tabStillOnObservedPage(tabId, observation.url))) return
    await showNotification(result, tabId)
    return
  }
  if (result.action !== "request_excerpt") return
  const remainingDwellMs = observation.tier2DwellMs - (Date.now() - observation.startedAt)
  if (remainingDwellMs > 0) {
    await delay(remainingDwellMs)
  }
  if (!(await tabStillOnObservedPage(tabId, observation.url))) return
  const excerpt = await extractFromTab(tabId)
  if (!excerpt) return
  if (!(await tabStillOnObservedPage(tabId, observation.url))) return
  const finalResult = await postObservationExcerpt(result.observation_id, excerpt)
  if (finalResult?.action === "notify" && finalResult.message) {
    if (!(await tabStillOnObservedPage(tabId, observation.url))) return
    await showNotification(finalResult, tabId)
  }
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
  persistD7Observations()
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
  const result = await postObservationPresence(tracked.observationId, {
    event_id: newPresenceEventId(),
    kind,
    tab_id: tabId,
    url_path_hash: tracked.urlPathHash,
  })
  if (kind !== "inactive" && result?.action === "notify" && result.message) {
    if (await tabStillActivelyViewed(tabId, tracked.url)) await showNotification(result, tabId)
  }
}

async function deactivateD7Observation(tabId: number): Promise<void> {
  await ensureD7ObservationsRestored()
  const tracked = activeD7Observations.get(tabId)
  if (!tracked) return
  activeD7Observations.delete(tabId)
  persistD7Observations()
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
    persistD7Observations()
    kind = "active"
  }
  if (!tracked.contentStored && !tracked.contentRetryAttempted) {
    tracked.contentRetryAttempted = true
    await captureD7Content(tab.id, tracked)
    persistD7Observations()
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
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
let lastAppliedStatus: BadgeStatus | null = null

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

async function refreshBadge(): Promise<void> {
  const status = await computeBadgeStatus()
  if (status === lastAppliedStatus) return
  lastAppliedStatus = status
  await applyStatusIcon(status)
}

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
  if (alarm.name === BADGE_ALARM) void refreshBadge()
  if (alarm.name === D7_HEARTBEAT_ALARM) void heartbeatD7Observation()
})

chrome.runtime.onMessage.addListener(
  (message: { type?: string; notificationId?: string; kind?: string; displayToken?: number } | undefined) => {
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
    await postFeedback({
      kind,
      intervention_id: toast.interventionId,
      observation_id: toast.observationId,
    })
  }
  pendingToasts.delete(notificationId)
  await clearSystemNotification(notificationId)
  void refreshBadge()
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) scheduleTabObservation(details.tabId, details.url)
})

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) {
    scheduleTabObservation(details.tabId, details.url)
    void redisplayLatestPendingToast(details.tabId)
  }
})

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) void redisplayLatestPendingToast(details.tabId)
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  clearInactiveTabTimers(activeInfo.tabId)
  scheduleTabObservation(activeInfo.tabId)
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
  clearTabTimer(tabId)
})

void refreshBadge()

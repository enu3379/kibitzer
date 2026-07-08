import { extractPageExcerpt } from "./content/readabilityExtract"
import { showKibitzerToast } from "./content/toastOverlay"
import {
  FeedbackKind,
  PageInfo,
  PageExcerpt,
  PipelineResult,
  getSessionState,
  postBrowserNav,
  postDeliveryReport,
  postFeedback,
  postObservationExcerpt,
} from "./lib/api"
import { shouldDropUrl } from "./lib/domainFilter"
import {
  ExplorationVerdict,
  prependExplorationHistory,
  updateExplorationHistory,
} from "./lib/history"

const OBSERVATION_DWELL_MS = 5000
const TIER2_DWELL_MS = 10000
const EXCERPT_LIMIT = 3500
const NOTIFICATION_ICON = "icons/icon-128.png"
const BADGE_ALARM = "kibitzer-badge-refresh"
const TOAST_AUTO_DISMISS_MS = 25000
const TOAST_CELEBRATION_AUTO_DISMISS_MS = 9000
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
}

let nextObservationToken = 0
const pendingTabObservations = new Map<number, PendingTabObservation>()
const pendingNotifications = new Map<string, { interventionId: string; observationId: string }>()

function scheduleTabObservation(tabId: number, observedUrl?: string): void {
  clearTabTimer(tabId)
  const token = ++nextObservationToken
  const startedAt = Date.now()
  pendingTabObservations.set(tabId, { token, url: "", startedAt, timer: 0 })
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
    observationDwellMs: OBSERVATION_DWELL_MS,
    tier2DwellMs: TIER2_DWELL_MS,
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
    await handlePipelineResult(tabId, result, { url, startedAt })
    void refreshBadge()
  }, OBSERVATION_DWELL_MS)
  pendingTabObservations.set(tabId, { token, url, startedAt, timer, historyId })
}

function makeHistoryId(token: number): string {
  return `hist_${Date.now()}_${token}`
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
  observation: { url: string; startedAt: number },
): Promise<void> {
  if (!result?.observation_id) return
  // Celebrations arrive directly on the browser-nav response (no excerpt round
  // trip). Show only if the user is still on the page they returned to.
  if (result.action === "notify" && result.kind === "celebration" && result.message) {
    if (!(await tabStillOnObservedPage(tabId, observation.url))) return
    await showNotification(result, tabId)
    return
  }
  if (result.action !== "request_excerpt") return
  const remainingDwellMs = TIER2_DWELL_MS - (Date.now() - observation.startedAt)
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
  const kind = result.kind ?? "intervention"
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
  if (!celebration && result.intervention_id) {
    pendingNotifications.set(notificationId, {
      interventionId: result.intervention_id,
      observationId: result.observation_id,
    })
  }

  // Preferred surface: an in-page toast on the drifting tab. It bypasses OS
  // notification settings (macOS banners were silently swallowed) and keeps the
  // kibitzer in the page it is kibitzing.
  if (tabId !== undefined) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showKibitzerToast,
        args: [
          {
            notificationId,
            message: result.message,
            contextLabel: pageLabel(result.page) ?? null,
            autoDismissMs: celebration ? TOAST_CELEBRATION_AUTO_DISMISS_MS : TOAST_AUTO_DISMISS_MS,
            kind,
          },
        ],
      })
      if (!celebration && result.intervention_id) {
        void postDeliveryReport(result.intervention_id, true)
        void playNotificationSound()
      }
      if (celebration) {
        void playNotificationSound("celebrate")
      }
      void refreshBadge()
      return
    } catch (error) {
      // Non-injectable surface (chrome:// pages, web store, PDF viewer) —
      // fall back to the system notification below.
      console.warn("kibitzer: in-page toast failed, falling back", error)
    }
  }

  try {
    const options: chrome.notifications.NotificationOptions<true> = {
      type: "basic",
      iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
      title: "Kibitzer",
      message: result.message,
      contextMessage: pageLabel(result.page),
      priority: celebration ? 0 : 2,
      requireInteraction: !celebration,
    }
    if (!celebration) {
      options.buttons = NOTIFICATION_BUTTONS.map((buttonKind) => ({ title: FEEDBACK_BUTTON_TITLES[buttonKind] }))
    }
    await chrome.notifications.create(notificationId, {
      ...options,
    })
    if (!celebration && result.intervention_id) {
      void postDeliveryReport(result.intervention_id, true)
      void playNotificationSound()
    }
    if (celebration) {
      void playNotificationSound("celebrate")
    }
    void refreshBadge()
  } catch (error) {
    pendingNotifications.delete(notificationId)
    console.error("kibitzer: notification create failed", error)
    if (!celebration && result.intervention_id) {
      void postDeliveryReport(result.intervention_id, false, String(error))
    }
  }
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
  const r = Math.max(2.4, size * 0.17)
  const inset = size * 0.07
  const cx = size - r - inset
  const cy = r + inset
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = Math.max(1, size * 0.06)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)" // thin ring separates the pip from icon + toolbar
  ctx.stroke()
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
})

chrome.runtime.onMessage.addListener(
  (message: { type?: string; notificationId?: string; kind?: string } | undefined) => {
    if (message?.type === "kibitzer:refresh-badge") void refreshBadge()
    if (message?.type === "kibitzer:toast-feedback" && message.notificationId) {
      const kind = message.kind
      if (kind === "related" || kind === "accepted" || kind === "snooze" || kind === "break") {
        void submitNotificationFeedback(message.notificationId, kind)
      } else {
        // dismissed / timeout: no feedback signal, just stop tracking it.
        pendingNotifications.delete(message.notificationId)
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
  pendingNotifications.delete(notificationId)
})

async function submitNotificationFeedback(
  notificationId: string,
  kind: FeedbackKind | undefined,
): Promise<void> {
  const metadata = pendingNotifications.get(notificationId)
  if (!metadata || !kind) return
  await postFeedback({
    kind,
    intervention_id: metadata.interventionId,
    observation_id: metadata.observationId,
  })
  pendingNotifications.delete(notificationId)
  await chrome.notifications.clear(notificationId)
  void refreshBadge()
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) scheduleTabObservation(details.tabId, details.url)
})

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) scheduleTabObservation(details.tabId, details.url)
})

chrome.tabs.onActivated.addListener((activeInfo) => {
  clearInactiveTabTimers(activeInfo.tabId)
  scheduleTabObservation(activeInfo.tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabTimer(tabId)
})

void refreshBadge()

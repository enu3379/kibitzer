// The gauge, wired to run for real. Holds the immersion state in the IndexedDB SSOT
// (lib/db.ts) so it survives browser restarts as well as service-worker teardown,
// serializes dispatches, and delivers nag/celebrate effects.

import { reduceGauge } from "../core/gauge/reducer.ts"
import { defaultGaugeConfig } from "../core/gauge/config.ts"
import { initGaugeState } from "../core/gauge/types.ts"
import type { GaugeConfig, GaugeEffect, GaugeEvent, GaugeState } from "../core/gauge/types.ts"
import { showKibitzerToast, type ToastPayload } from "../content/toastOverlay.ts"
import { tier2Confirm } from "./tier12.ts"
import { getGoal } from "./session.ts"
import { activePersona, clampSentences, DEFAULT_MAX_SENTENCES, pickCelebrate, pickFallback } from "./personas.ts"
import { klog } from "./klog.ts"
import { playChime, speak } from "./chime.ts"
import { shouldDropUrl } from "./domainFilter.ts"
import { getSettings, inQuietHours } from "./settings.ts"
import { pageKeyOf } from "./url.ts"
import { extractPageExcerpt } from "../content/pageExcerpt.ts"
import { updateBadge } from "./badge.ts"
import { clearStore, drainRecords, kvGet, kvPutAndAppend, kvSet, OUTBOX_STORE } from "./db.ts"
import { logEvent } from "./events.ts"
import { clearRelevance } from "./relevance.ts"
import {
  clearHistory,
  lastNagIgnored,
  nagCountToday,
  recentTitles,
  recordNag,
  repeatHost,
} from "./history.ts"
import type { SessionGoal } from "./session.ts"

const EXCERPT_LIMIT = 3500 // extraction cap; the Tier-2 payload re-cleans to 3000

const STATE_KEY = "gauge-state"
const ACTIVE_PAGE_KEY = "active-page"
const DRIFT_SINCE_KEY = "drift-since"

export interface ActivePage {
  pageKey: string
  title: string
  urlHost: string
  score: number
}

// A gauge effect queued for durable delivery. Persisted atomically with the gauge
// checkpoint (see dispatch) so it survives a service-worker teardown before delivery.
// `writerMessage` snapshots the Tier-2 Writer's nag text at enqueue time — it used to
// live in an in-memory global that was lost across teardown.
interface OutboxEntry {
  effect: GaugeEffect
  goal: SessionGoal | null
  ts: number
  writerMessage: string | null
}
type OutboxRecord = OutboxEntry & { id: number }

/** Remember the active page's details so the async Tier 2 gate can judge it. */
export async function setActivePage(page: ActivePage): Promise<void> {
  await kvSet(ACTIVE_PAGE_KEY, page)
}

async function getActivePage(): Promise<ActivePage | null> {
  const value = await kvGet<ActivePage>(ACTIVE_PAGE_KEY)
  return value && typeof value.pageKey === "string" ? value : null
}

function isGaugeState(value: unknown): value is GaugeState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as GaugeState).s === "number" &&
    typeof (value as GaugeState).m === "number" &&
    typeof (value as GaugeState).accelTier === "number"
  )
}

async function loadState(): Promise<GaugeState> {
  try {
    const value = await kvGet<GaugeState>(STATE_KEY)
    return isGaugeState(value) ? value : initGaugeState()
  } catch {
    return initGaugeState()
  }
}

async function saveState(state: GaugeState): Promise<void> {
  await kvSet(STATE_KEY, state)
}

export async function currentState(): Promise<GaugeState> {
  return loadState()
}

export async function resetState(): Promise<void> {
  await kvSet(STATE_KEY, initGaugeState())
  await kvSet(DRIFT_SINCE_KEY, null)
  await clearStore(OUTBOX_STORE) // drop effects queued under the old goal
  pendingNagMessage = null
  await clearHistory() // a new goal starts a fresh nag/visit context
  await clearRelevance() // …and fresh Tier-0 exemplars/anchor/derived vectors
}

// --- drift timing (persona drift_minutes + celebration return_minutes) -----------

async function setDriftSince(ts: number | null): Promise<void> {
  await kvSet(DRIFT_SINCE_KEY, ts)
}

async function driftSince(): Promise<number | null> {
  const since = await kvGet<number | null>(DRIFT_SINCE_KEY)
  return typeof since === "number" ? since : null
}

/** Minutes since drift began (≥1), for the persona celebration templates. */
async function returnMinutes(now: number): Promise<number> {
  const since = await driftSince()
  return since == null ? 1 : Math.max(1, Math.round((now - since) / 60_000))
}

/** Minutes off-goal so far (null when not drifting) — the persona's drift_minutes. */
async function driftMinutes(now: number): Promise<number | null> {
  const since = await driftSince()
  return since == null ? null : Math.max(0, Math.round((now - since) / 60_000))
}

function configFor(goal: SessionGoal | null): GaugeConfig {
  return defaultGaugeConfig(goal?.availableMinutes ?? null)
}

let queue: Promise<void> = Promise.resolve()

/** Apply one gauge event (serialized): reduce, persist the new state AND its effects in one
 *  atomic write, then drain the durable outbox. Because the effects are committed together
 *  with the state, a teardown between save and delivery can lose neither — the next drain
 *  (this one or a startup flush) delivers whatever is still queued. */
export function dispatch(event: GaugeEvent, goal: SessionGoal | null): Promise<void> {
  const task = async (): Promise<void> => {
    const state = await loadState()
    const transition = reduceGauge(state, event, configFor(goal))
    // Diagnostic trace (service-worker console): watch S drain/recover and why an
    // effect fired. Remove once the pipeline is trusted.
    const s0 = state.s.toFixed(1)
    const s1 = transition.state.s.toFixed(1)
    if (s0 !== s1 || transition.effects.length > 0) {
      const eff = transition.effects.map((e) => e.type).join(",")
      klog(
        `${event.type} S ${s0}->${s1} m=${transition.state.m.toFixed(2)}` +
          ` armed=${transition.state.celebrateArmed} v=${transition.state.activeVerdict}` +
          (eff ? ` !! ${eff}` : ""),
      )
    }
    // Snapshot the Writer nag text (if any) onto the effect NOW, so it is durable rather
    // than riding an in-memory global that teardown would drop.
    const entries: OutboxEntry[] = transition.effects.map((effect) => ({
      effect,
      goal,
      ts: event.ts,
      writerMessage: effect.type === "nag" ? consumePendingNag() : null,
    }))
    await persistStateAndOutbox(transition.state, entries)
    updateBadge(transition.state, goal, event.ts) // reflect live status on the toolbar
    // Mark when a drift episode began, so the celebration can say how long they were away.
    if (state.activeVerdict !== "DRIFT" && transition.state.activeVerdict === "DRIFT") {
      await setDriftSince(event.ts)
    }
    await drainOutbox()
  }
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Persist the gauge checkpoint and enqueue its effects. When there are effects, both land
 *  in one transaction (atomic); with none, it is a plain state save. */
async function persistStateAndOutbox(state: GaugeState, entries: OutboxEntry[]): Promise<void> {
  if (entries.length === 0) {
    await saveState(state)
    return
  }
  await kvPutAndAppend([{ key: STATE_KEY, value: state }], OUTBOX_STORE, entries)
}

/** Deliver every queued effect (oldest first), removing each on success. Serialized with
 *  dispatch through `queue`, so drains never overlap. */
async function drainOutbox(): Promise<void> {
  await drainRecords<OutboxRecord>(OUTBOX_STORE, (record) =>
    deliver(record.effect, record.goal, record.ts, record.writerMessage),
  )
}

/** Deliver any effects left in the outbox by a prior service-worker lifetime. Routed
 *  through the dispatch queue so it can't race a live dispatch. Call on SW startup/wake. */
export function flushOutbox(): Promise<void> {
  const run = queue.then(drainOutbox, drainOutbox)
  queue = run.catch(() => undefined)
  return run
}

/** Fire a nag notification immediately, for manual testing (goal = "알림보기"). */
export async function testNag(goal: SessionGoal | null): Promise<void> {
  await deliver({ type: "nag", pageKey: "test" }, goal, Date.now(), null)
}

let pendingNagMessage: string | null = null

/** Read and clear the Writer's pending nag message (set by serviceTier2 before it
 *  dispatches the drift result). Consumed at enqueue time so it is snapshotted durably. */
function consumePendingNag(): string | null {
  const message = pendingNagMessage
  pendingNagMessage = null
  return message
}

async function deliver(
  effect: GaugeEffect,
  goal: SessionGoal | null,
  ts: number,
  writerMessage: string | null,
): Promise<void> {
  const goalText = goal?.text ?? "목표"
  if (effect.type === "request_tier2") {
    // Service the Tier 2 gate off the dispatch queue (Ollama is slow); it dispatches
    // a tier2_result back into the gauge when it resolves.
    void serviceTier2(effect, goal)
    return
  }
  if (effect.type === "nag") {
    const settings = await getSettings()
    // Do-not-disturb: within quiet hours, drop the nudge (the drift is still logged).
    if (inQuietHours(settings.quietHours, ts)) {
      klog(`nag suppressed (quiet hours)`)
      logEvent("nag", { pageKey: effect.pageKey, suppressed: "quiet_hours" })
      return
    }
    const page = await getActivePage()
    // Persona voice for EVERY nag: the Tier-2 Writer message when we have one (fresh
    // gate), otherwise the persona's fallback template. This covers degraded mode,
    // renags, cached-drift nags, and the "알림보기" test — all were showing the plain
    // line before. The generic sentence is only a last resort (no persona templates).
    const fromWriter = writerMessage != null
    let message = writerMessage
    if (!message) {
      const persona = await activePersona()
      const nagCount = (await nagCountToday(ts)) + 1
      const fallback = pickFallback(persona, nagCount, {
        goal: goalText,
        title: page?.title || page?.urlHost || "현재 페이지",
        host: page?.urlHost || "현재 페이지",
      })
      message = fallback
        ? clampSentences(fallback, persona.maxSentences ?? DEFAULT_MAX_SENTENCES)
        : `'${goalText}' 흐름에서 벗어난 것 같아요. 계속 필요한 곁가지인지 확인해볼까요?`
    }
    klog(`nag (${fromWriter ? "writer" : "fallback"}): "${message.slice(0, 48)}"`)
    logEvent("nag", { pageKey: effect.pageKey, source: fromWriter ? "writer" : "fallback", message })
    const token = await showToast(message, effect.pageKey, "intervention")
    if (token != null) {
      await recordNag({ ts, host: page?.urlHost ?? "", token })
      if (settings.ttsEnabled) void speak(message) // read the nudge aloud
    }
  } else if (effect.type === "celebrate") {
    // Celebrate in the selected persona's voice; fall back to the plain line.
    const persona = await activePersona()
    const message =
      pickCelebrate(persona, { goal: goalText, returnMinutes: await returnMinutes(ts) }) ??
      `'${goalText}'에 다시 집중하고 있네요 👍`
    await setDriftSince(null)
    klog(`celebrate: "${message.slice(0, 48)}"`)
    logEvent("celebrate", { message })
    await showToast(message, null, "celebration")
  }
}

/** Grab the active tab's body text for the Tier-2 judge — but only if the active tab is
 *  still the page being judged and it isn't sensitive. Null on any mismatch/failure
 *  (the judge then falls back to title-only, as before). */
async function extractActiveExcerpt(pageKey: string): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || !tab.url || shouldDropUrl(tab.url) || pageKeyOf(tab.url) !== pageKey) return null
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageExcerpt,
      args: [EXCERPT_LIMIT],
    })
    const result = injected?.result as { text?: string } | undefined
    return result?.text ?? null
  } catch {
    return null // chrome://, PDF, web store — no injection possible
  }
}

async function serviceTier2(
  effect: Extract<GaugeEffect, { type: "request_tier2" }>,
  goal: SessionGoal | null,
): Promise<void> {
  const page = await getActivePage()
  if (!page || page.pageKey !== effect.pageKey) return
  // Build the persona's message context from the nag / visit history (mirrors the
  // server's _nagging_context). nag_count_today is the count BEFORE this nag.
  const now = Date.now()
  const [count, ignored, repeat, drift, titles, excerpt] = await Promise.all([
    nagCountToday(now),
    lastNagIgnored(),
    repeatHost(page.urlHost),
    driftMinutes(now),
    recentTitles(),
    extractActiveExcerpt(effect.pageKey),
  ])
  // Declared time budget → the judge/writer treat it as background pressure.
  const timeContext =
    goal?.availableMinutes != null
      ? {
          available_time_minutes: goal.availableMinutes,
          elapsed_minutes: Math.round((now - goal.startedAt) / 60_000),
          current_page_drift_minutes: drift,
        }
      : null
  const outcome = await tier2Confirm(goal?.text ?? "", page, {
    nagCount: count + 1,
    naggingContext: {
      nag_count_today: count,
      last_nag_ignored: ignored,
      drift_minutes: drift,
      repeat_host: repeat,
    },
    recentTitles: titles,
    excerpt,
    timeContext,
  })
  // Drop the result if the goal changed (new revision, or cleared) while Tier-2 was in
  // flight — otherwise a verdict/nag judged under the old goal lands against the new one.
  const current = await getGoal()
  if (!current || !goal || current.revision !== goal.revision) {
    klog(`tier2 result dropped (goal changed) on ${effect.pageKey}`)
    logEvent("tier2", { pageKey: effect.pageKey, reason: effect.reason, flow: outcome.flow, dropped: true })
    return
  }
  klog(`tier2 gate (${effect.reason}) on ${effect.pageKey} excerpt=${excerpt?.length ?? 0}c -> ${outcome.flow}`)
  logEvent("tier2", { pageKey: effect.pageKey, reason: effect.reason, flow: outcome.flow, excerpt: excerpt?.length ?? 0 })
  // The Writer's message rides along to the nag toast (if drift is confirmed).
  if (outcome.flow === "drift" && outcome.message) pendingNagMessage = outcome.message
  await dispatch(
    { type: "tier2_result", flow: outcome.flow, pageKey: effect.pageKey, ts: Date.now() },
    goal,
  )
}

let toastToken = 0

/** Render the in-page toast overlay in the active tab (matches apps/extension — a quiet
 *  on-page bubble). Injected via executeScript; falls back to an OS notification when the
 *  page can't be injected (chrome://, the web store, PDF viewer, no active tab) so the
 *  nudge is never silently dropped. Returns the displayToken (to log the nag), or null. */
async function showToast(
  message: string,
  contextLabel: string | null,
  kind: "intervention" | "celebration",
): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  // Privacy: never surface a nudge on a sensitive page, even if one was queued before
  // the user navigated there.
  if (tab?.url && shouldDropUrl(tab.url)) return null
  void playChime(kind) // audible cue via the offscreen document (works off-screen)
  const token = (toastToken += 1)
  if (tab?.id) {
    const payload: ToastPayload = {
      notificationId: `kbz-${token}`,
      displayToken: token,
      message,
      contextLabel,
      autoDismissMs: 12_000,
      kind,
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showKibitzerToast,
        args: [payload],
      })
      return token
    } catch {
      // Injection blocked (chrome://, web store, PDF) — fall through to a notification.
    }
  }
  showSystemNotification(token, message, kind)
  return token
}

/** OS-notification fallback for pages that can't host the in-page toast. Buttons feed the
 *  same feedback path as the toast (see background's notifications.onButtonClicked). */
function showSystemNotification(
  token: number,
  message: string,
  kind: "intervention" | "celebration",
): void {
  try {
    chrome.notifications.create(`kbz-${token}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Kibitzer",
      message,
      buttons:
        kind === "intervention" ? [{ title: "목표와 관련 있어요" }, { title: "5분만" }] : [],
    })
  } catch {
    // No notifications permission / platform limit — nothing more we can do.
  }
}

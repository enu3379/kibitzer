// The gauge, wired to run for real. Holds the immersion state in the IndexedDB SSOT
// (lib/db.ts) so it survives browser restarts as well as service-worker teardown,
// serializes dispatches, and delivers nag/celebrate effects.

import { reduceGauge } from "../core/gauge/reducer.ts"
import { defaultGaugeConfig } from "../core/gauge/config.ts"
import { initGaugeState } from "../core/gauge/types.ts"
import type { Flow, GaugeConfig, GaugeEffect, GaugeEvent, GaugeState } from "../core/gauge/types.ts"
import { tokenMatchesPending, type Tier2Token } from "./tier2Token.ts"
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
import { deleteRecord, drainRecords, kvGet, kvPutAndAppend, kvSet, kvWriteAndClear, OUTBOX_STORE } from "./db.ts"
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
  // For a request_tier2 effect: the requestedAt of the pending slot it opened, so the job
  // can identify its exact request instance (not just page+reason) end-to-end.
  requestedAt?: number
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

export function resetState(): Promise<void> {
  // Serialize with dispatch (so a reset can't interleave with an in-flight event) and wipe
  // the gauge state, drift clock, staged Writer message, and queued effects in ONE
  // transaction — a half-applied reset could otherwise revive stale state or effects.
  return enqueue(async () => {
    await kvWriteAndClear(
      [
        { key: STATE_KEY, value: initGaugeState() },
        { key: DRIFT_SINCE_KEY, value: null },
      ],
      [PENDING_WRITER_KEY],
      [OUTBOX_STORE],
    )
    await clearHistory() // a new goal starts a fresh nag/visit context
    await clearRelevance() // …and fresh Tier-0 exemplars/anchor/derived vectors
  })
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

/** Serialize a unit of gauge work onto the single dispatch queue. */
function enqueue(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Reduce one event against `state`, persist the new state AND its effects in one atomic
 *  write, then drain the durable outbox. Shared by dispatch and the Tier-2 apply so both go
 *  through the same atomic-checkpoint path. */
async function runEvent(event: GaugeEvent, goal: SessionGoal | null, state: GaugeState): Promise<void> {
  const transition = reduceGauge(state, event, configFor(goal))
  // Diagnostic trace (service-worker console): watch S drain/recover and why an effect fired.
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
  // Bind the Writer nag text (staged durably by the Tier-2 apply) to its nag effect, and a
  // request_tier2's requestedAt to its record, so both ride the outbox rather than in-memory
  // state that teardown would drop. The consumed Writer key is deleted in the SAME atomic
  // write as the outbox append (see persistStateAndOutbox), so the read→delete→enqueue can't
  // lose it across a teardown.
  const entries: OutboxEntry[] = []
  const kvDeletes: string[] = []
  for (const effect of transition.effects) {
    let writerMessage: string | null = null
    if (effect.type === "nag") {
      writerMessage = await readWriterFor(effect.pageKey)
      if (writerMessage != null) kvDeletes.push(PENDING_WRITER_KEY)
    }
    const requestedAt = effect.type === "request_tier2" ? transition.state.pendingTier2?.requestedAt : undefined
    entries.push({ effect, goal, ts: event.ts, writerMessage, requestedAt })
  }
  await persistStateAndOutbox(transition.state, entries, kvDeletes)
  updateBadge(transition.state, goal, event.ts) // reflect live status on the toolbar
  // Mark when a drift episode began, so the celebration can say how long they were away.
  if (state.activeVerdict !== "DRIFT" && transition.state.activeVerdict === "DRIFT") {
    await setDriftSince(event.ts)
  }
  await drainOutbox()
}

/** Apply one gauge event (serialized): load state, reduce, persist atomically, drain. */
export function dispatch(event: GaugeEvent, goal: SessionGoal | null): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    await runEvent(event, goal, state)
  })
}

/** Persist the gauge checkpoint, enqueue its effects, and drop the consumed Writer key —
 *  all in one transaction (atomic) when there are effects; a plain state save otherwise. */
async function persistStateAndOutbox(
  state: GaugeState,
  entries: OutboxEntry[],
  kvDeletes: string[],
): Promise<void> {
  if (entries.length === 0) {
    await saveState(state)
    return
  }
  await kvPutAndAppend([{ key: STATE_KEY, value: state }], OUTBOX_STORE, entries, kvDeletes)
}

// Tier-2 jobs currently being serviced, by outbox record id — single-flight, so a duplicate
// drain (or a wake mid-job) can't run the same slow Ollama request twice.
const inFlightTier2 = new Set<number>()

/** Drain the outbox (oldest first). Terminal effects (nag/celebrate) deliver and ACK. A
 *  request_tier2 is a durable job: it is NOT ACKed here — startTier2Job owns its lifetime and
 *  deletes the record only after the outcome is durably reflected or stale-cancelled. */
async function drainOutbox(): Promise<void> {
  await drainRecords<OutboxRecord>(OUTBOX_STORE, async (record) => {
    if (record.effect.type === "request_tier2") {
      startTier2Job(record)
      return false // keep; the job self-ACKs when it truly completes
    }
    await deliver(record.effect, record.goal, record.ts, record.writerMessage)
    return true
  })
}

/** Deliver/finish any work left in the outbox by a prior service-worker lifetime. Serialized
 *  with dispatch. Call on SW startup/wake. */
export function flushOutbox(): Promise<void> {
  return enqueue(drainOutbox)
}

/** Service a Tier-2 request as a durable job: single-flight by record id, run the slow gate
 *  off the dispatch queue, and ACK (delete the outbox record) only after the outcome is
 *  durably reflected into the gauge or the request is cancelled as stale. A teardown before
 *  it resolves leaves the record, so the next drain/startup retries the same request. */
function startTier2Job(record: OutboxRecord): void {
  const effect = record.effect
  if (effect.type !== "request_tier2") return
  if (inFlightTier2.has(record.id)) return
  inFlightTier2.add(record.id)
  void serviceTier2(effect, record.goal, record.requestedAt ?? -1)
    .then(() => deleteRecord(OUTBOX_STORE, record.id)) // ACK only after durable reflection
    .catch((error) => klog(`tier2 job kept for retry: ${String(error)}`))
    .finally(() => inFlightTier2.delete(record.id))
}

/** Apply a fresh Tier-2 outcome, guarded (serialized) against the live state: only if the
 *  pending slot is still this exact request instance, the goal epoch is unchanged, and the
 *  judged page is still active. Otherwise release the slot without touching the current page
 *  (tier2_cancel). This is the page/goal guard the stale-verdict fix (B2) builds on. */
function dispatchTier2(
  token: Tier2Token,
  flow: Flow,
  message: string | null,
  goal: SessionGoal | null,
): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    if (!tokenMatchesPending(token, state.pendingTier2)) return // superseded by a newer request
    const current = await getGoal()
    const fresh = current != null && current.epoch === token.epoch && state.activePageKey === token.pageKey
    if (!fresh) {
      await runEvent(
        { type: "tier2_cancel", pageKey: token.pageKey, requestedAt: token.requestedAt, ts: Date.now() },
        goal,
        state,
      )
      return
    }
    if (flow === "drift" && message) await setPendingWriter(token.pageKey, message)
    await runEvent({ type: "tier2_result", flow, pageKey: token.pageKey, ts: Date.now() }, goal, state)
  })
}

/** Release a pending Tier-2 slot judged stale before the gate even ran (page/goal moved on
 *  during the dwell), so promotion isn't wedged. Only clears this exact request instance — a
 *  newer same-page/reason request is left intact — and never touches the current page. */
function cancelTier2(token: Tier2Token): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    if (!tokenMatchesPending(token, state.pendingTier2)) return
    await runEvent(
      { type: "tier2_cancel", pageKey: token.pageKey, requestedAt: token.requestedAt, ts: Date.now() },
      null,
      state,
    )
  })
}

/** Fire a nag notification immediately, for manual testing (goal = "알림보기"). */
export async function testNag(goal: SessionGoal | null): Promise<void> {
  await deliver({ type: "nag", pageKey: "test" }, goal, Date.now(), null)
}

const PENDING_WRITER_KEY = "pending-writer"

/** Persist the Tier-2 Writer's nag text for a page, so the nag effect it triggers can carry
 *  the persona message even across a teardown (replaces the old in-memory global). */
async function setPendingWriter(pageKey: string, message: string): Promise<void> {
  await kvSet(PENDING_WRITER_KEY, { pageKey, message })
}

/** Read the staged Writer message iff it is for this page (no delete — the caller removes
 *  the key inside the same atomic outbox write, so a teardown can't drop it mid-move). */
async function readWriterFor(pageKey: string): Promise<string | null> {
  const value = await kvGet<{ pageKey: string; message: string }>(PENDING_WRITER_KEY)
  return value && value.pageKey === pageKey ? value.message : null
}

async function deliver(
  effect: GaugeEffect,
  goal: SessionGoal | null,
  ts: number,
  writerMessage: string | null,
): Promise<void> {
  const goalText = goal?.text ?? "목표"
  // request_tier2 is never delivered here — it is a durable job handled by startTier2Job.
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
  requestedAt: number,
): Promise<void> {
  const token: Tier2Token = { pageKey: effect.pageKey, reason: effect.reason, requestedAt, epoch: goal?.epoch ?? -1 }
  // Superseded before we even started (a newer request took the slot, or a prior run of this
  // same job already resolved it and we're a retry): nothing to service or clear — resolve so
  // the record is ACKed. The authoritative re-check happens inside dispatchTier2/cancelTier2.
  if (!tokenMatchesPending(token, (await loadState()).pendingTier2)) {
    klog(`tier2 skipped (superseded/settled) on ${effect.pageKey}`)
    return
  }
  const page = await getActivePage()
  const current = await getGoal()
  // Stale before the gate even ran (user navigated away / changed the goal during the dwell):
  // don't spend an Ollama call, but DO release the pending slot so promotion isn't wedged.
  if (!page || page.pageKey !== effect.pageKey || !goal || !current || current.epoch !== goal.epoch) {
    klog(`tier2 cancelled (stale pre-gate) on ${effect.pageKey}`)
    logEvent("tier2", { pageKey: effect.pageKey, reason: effect.reason, cancelled: true })
    await cancelTier2(token)
    return
  }
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
  klog(`tier2 gate (${effect.reason}) on ${effect.pageKey} excerpt=${excerpt?.length ?? 0}c -> ${outcome.flow}`)
  logEvent("tier2", { pageKey: effect.pageKey, reason: effect.reason, flow: outcome.flow, excerpt: excerpt?.length ?? 0 })
  // Apply guarded: dispatchTier2 re-checks (serialized) that the pending slot, goal revision,
  // and active page still match before applying — else it releases the slot (tier2_cancel)
  // with no side effect on whatever page the user is on now. The Writer message is staged
  // durably and bound to the nag effect inside runEvent.
  await dispatchTier2(token, outcome.flow, outcome.flow === "drift" ? outcome.message : null, goal)
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

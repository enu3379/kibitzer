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
import { playChime } from "./chime.ts"
import { shouldDropUrl } from "./domainFilter.ts"
import { initDomainLists } from "./domainLists.ts"
import { getSettings, inQuietHours, localPdfPolicyMatches } from "./settings.ts"
import { describeObservableUrl, type ObservablePageKind } from "./url.ts"
import { browserPresent } from "./presence.ts"
import { extractPageExcerpt } from "../content/pageExcerpt.ts"
import { updateBadge } from "./badge.ts"
import { deleteRecord, drainRecords, kvDelete, kvDeleteIf, kvGet, kvPutAndAppend, kvSet, kvTakeIf, kvUpdate, kvWriteAndClear, OUTBOX_STORE } from "./db.ts"
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
  kind: ObservablePageKind
  localPdfPolicyRevision: number | null
}

interface EffectSource {
  kind: ObservablePageKind
  localPdfPolicyRevision: number | null
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
  source?: EffectSource | null
  // For a request_tier2 effect: the opaque requestId of the pending slot it opened, so the
  // job identifies its exact request instance end-to-end (page+reason+requestedAt can collide).
  requestId?: number
}
type OutboxRecord = OutboxEntry & { id: number }

/** Remember the active page's details so the async Tier 2 gate can judge it. */
export async function setActivePage(page: ActivePage): Promise<void> {
  await kvSet(ACTIVE_PAGE_KEY, page)
}

async function getActivePage(): Promise<ActivePage | null> {
  const value = await kvGet<ActivePage>(ACTIVE_PAGE_KEY)
  if (!value || typeof value.pageKey !== "string") return null
  // Pre-feature web checkpoints have no kind. They remain safe web observations.
  if (value.kind !== "local_pdf" && value.kind !== "web") {
    return { ...value, kind: "web", localPdfPolicyRevision: null }
  }
  return value
}

async function effectSourceAllowed(source: EffectSource | null | undefined): Promise<boolean> {
  if (source?.kind !== "local_pdf") return true
  return source.localPdfPolicyRevision != null && localPdfPolicyMatches(source.localPdfPolicyRevision)
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
    // Preserve the monotonic Tier-2 request counter across the reset so a requestId is never
    // REUSED: an in-flight (zombie) job from before the reset would otherwise collide with a
    // fresh request that got the same id and wrongly cancel/apply to it.
    const prev = await loadState()
    // Guard a non-finite counter (a legacy/corrupt state) — else the next request would
    // compute `undefined/NaN + 1 = NaN` and permanently wedge pendingTier2 (NaN never matches).
    const carriedSeq = Number.isFinite(prev.tier2ReqSeq) ? prev.tier2ReqSeq : 0
    const fresh = { ...initGaugeState(), tier2ReqSeq: carriedSeq }
    await kvWriteAndClear(
      [
        { key: STATE_KEY, value: fresh },
        { key: DRIFT_SINCE_KEY, value: null },
      ],
      [PENDING_WRITER_KEY, NAG_HOLD_KEY], // a held nag must not outlive its session
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
  // Diagnostic trace: tie every S move / verdict change / effect to the page the verdict is
  // based on, so a score change can be read against the page that caused it. NEUTRAL = the
  // gauge is holding steady while a page's dwell is judged (no drain / no recover). The klog
  // line is for humans; the durable `tick` event lets offline replay reconstruct the S curve
  // against the active page.
  const s0 = state.s.toFixed(1)
  const s1 = transition.state.s.toFixed(1)
  const verdictChanged = state.activeVerdict !== transition.state.activeVerdict
  if (s0 !== s1 || transition.effects.length > 0 || verdictChanged) {
    const eff = transition.effects.map((e) => e.type).join(",")
    const vLabel = transition.state.activeVerdict ?? "NEUTRAL"
    const page = transition.state.activePageKey ?? "—"
    klog(
      `${event.type} S ${s0}->${s1} m=${transition.state.m.toFixed(2)}` +
        ` armed=${transition.state.celebrateArmed} v=${vLabel} page=${page}` +
        (eff ? ` !! ${eff}` : ""),
    )
    logEvent("tick", {
      event: event.type,
      s: Math.round(transition.state.s),
      m: Number(transition.state.m.toFixed(3)),
      verdict: transition.state.activeVerdict, // null ⇒ NEUTRAL (holding for a dwell)
      page: transition.state.activePageKey, // the page the verdict is based on
      prevVerdict: state.activeVerdict,
      prevPage: state.activePageKey,
      ...(transition.effects.length ? { effects: transition.effects.map((e) => e.type) } : {}),
    })
  }
  // Bind the Writer nag text (staged durably by the Tier-2 apply) to its nag effect, and a
  // request_tier2's requestedAt to its record, so both ride the outbox rather than in-memory
  // state that teardown would drop. The consumed Writer key is deleted in the SAME atomic
  // write as the outbox append (see persistStateAndOutbox), so the read→delete→enqueue can't
  // lose it across a teardown.
  const entries: OutboxEntry[] = []
  const kvDeletes: string[] = []
  const activePage = transition.effects.length > 0 ? await getActivePage() : null
  for (const effect of transition.effects) {
    let writerMessage: string | null = null
    if (effect.type === "nag") {
      writerMessage = await readWriterFor(effect.pageKey)
      if (writerMessage != null) kvDeletes.push(PENDING_WRITER_KEY)
    }
    // Read the id off the EFFECT, not final state: a promotion+s_zero in one reduce leaves
    // pendingTier2 as the s_zero's slot, so final state would mis-tag the promotion record.
    const requestId = effect.type === "request_tier2" ? effect.requestId : undefined
    const source =
      activePage && (effect.type === "celebrate" || activePage.pageKey === effect.pageKey)
        ? { kind: activePage.kind, localPdfPolicyRevision: activePage.localPdfPolicyRevision }
        : null
    entries.push({ effect, goal, ts: event.ts, writerMessage, requestId, source })
  }
  await persistStateAndOutbox(transition.state, entries, kvDeletes)
  updateBadge(transition.state, goal, event.ts) // reflect live status on the toolbar
  // D19 합의안 5: a recovery (S back past rDismiss, or the held page flipping OK) makes a
  // parked nag unjustified the moment it happens — not at the next delivery attempt. Awaited
  // BEFORE the drain below, so an old hold is settled before this same event's effects could
  // park a new one (fire-and-forget here would race the drain nondeterministically).
  await invalidateHoldOnRecovery(state, transition.state, configFor(goal))
  // Track when the drift episode began (persona drift_minutes / celebration return_minutes).
  // Start the clock on entering DRIFT, but only when one isn't already running: a NEUTRAL hold
  // between two off-goal pages nulls the verdict in between, and without the "already running"
  // guard the next DRIFT would reset the clock on every navigation and undercount a continuous
  // cross-page drift. Clear it the moment the gauge fully recovers on-goal (S crosses back to
  // 100 on OK) so the NEXT drift is timed from its own start; the celebration path clears it on
  // its own if it fires first.
  if (transition.state.activeVerdict === "DRIFT" && (await driftSince()) == null) {
    await setDriftSince(event.ts)
  } else if (transition.state.activeVerdict === "OK" && transition.state.s >= 100 && state.s < 100) {
    await setDriftSince(null)
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

/** Absorb browser downtime (restart-continue / suspend-resume, sessionRestore.ts): rebase the
 *  reducer clock via an `inactive` event so advance() can't integrate up to gapCap seconds of
 *  the gap under the pre-shutdown verdict, and push the wall-clock drift timer past the gap so
 *  drift_minutes / return_minutes don't count time the browser was closed. Serialized. */
export function rebaseAfterGap(gapMs: number, goal: SessionGoal | null): Promise<void> {
  return enqueue(async () => {
    if (gapMs > 0) {
      const since = await driftSince()
      if (since != null) await setDriftSince(since + gapMs)
    }
    const state = await loadState()
    await runEvent({ type: "inactive", ts: Date.now() }, goal, state)
  })
}

/** Put the gauge into the NEUTRAL holding state for a newly-observed page: stop integrating the
 *  previous page's verdict so S neither drains nor recovers while we wait for this page's dwell
 *  and judgement (which resume integration all at once via a `nav` event). A no-op when the
 *  gauge is already neutral or already holds THIS exact page — so same-page title churn and
 *  repeated observations never disturb a live verdict. Serialized with dispatch so the
 *  read-then-neutral can't race an in-flight event. */
export function enterNeutral(pageKey: string, goal: SessionGoal | null): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    if (state.activeVerdict == null) return // already neutral (or never judged this session)
    if (state.activePageKey === pageKey) return // still the page we hold a verdict for
    await runEvent({ type: "neutral", pageKey, ts: Date.now() }, goal, state)
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
    // Orphaned (session ended/suspended while it sat queued): ACK without delivering.
    // Freshness is deliver()'s job now — the nag TTL is judged strictly at the delivery
    // moment (D19), and celebrates are gated on the live verdict + purged at restart.
    if (!(await getGoal())) {
      klog(`outbox ${record.effect.type} dropped (no session)`)
      return true
    }
    await deliver(record.effect, record.goal, record.ts, record.writerMessage, record.source)
    return true
  })
}

/** Drop every queued celebrate without delivering (restart path, sessionRestore). A praise
 *  that crosses a full browser shutdown congratulates a recovery arc the relaunch already
 *  broke — and by construction its `celebrateArmed` was consumed when it was queued, so
 *  dropping the record loses exactly one (rare, teardown-orphaned) toast and nothing else. */
export function purgeQueuedCelebrates(): Promise<void> {
  return enqueue(async () => {
    await drainRecords<OutboxRecord>(OUTBOX_STORE, async (record) => record.effect.type === "celebrate")
  })
}

/** Clear the celebration arm (suspended-session resume, sessionRestore): 새로 브라우저를 열고
 *  아직 딱히 한 것도 없는데 다짜고짜 칭찬 메시지가 뜨는 것을 지양하기 위함. Only the stale
 *  half-old arc dies: a session parked with S ≤ cArm re-arms on its first integrating tick
 *  after resume, so a recovery that truly happens post-resume still gets its praise. */
export function disarmCelebrate(): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    if (!state.celebrateArmed) return
    await saveState({ ...state, celebrateArmed: false })
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
  void serviceTier2(effect, record.goal, record.requestId ?? -1)
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
    const activePage = await getActivePage()
    const fresh =
      current != null &&
      current.epoch === token.epoch &&
      state.activePageKey === token.pageKey &&
      activePage?.pageKey === token.pageKey &&
      (await effectSourceAllowed(activePage))
    if (!fresh) {
      await runEvent({ type: "tier2_cancel", requestId: token.requestId, ts: Date.now() }, goal, state)
      return
    }
    if (flow === "drift" && message) await setPendingWriter(token.pageKey, message)
    await runEvent({ type: "tier2_result", flow, pageKey: token.pageKey, ts: Date.now() }, goal, state)
    // Drop the staged text if no nag consumed it this tick (promotion-drift escalates without
    // nagging; a snoozed page emits none) so it can't attach to a later/different nag.
    if (flow === "drift" && message) {
      await kvDeleteIf(
        PENDING_WRITER_KEY,
        (v) => (v as { pageKey?: string; message?: string })?.pageKey === token.pageKey &&
          (v as { message?: string })?.message === message,
      )
    }
  })
}

/** Release a pending Tier-2 slot judged stale before the gate even ran (page/goal moved on
 *  during the dwell), so promotion isn't wedged. Only clears this exact request instance — a
 *  newer same-page/reason request is left intact — and never touches the current page. */
function cancelTier2(token: Tier2Token): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    if (!tokenMatchesPending(token, state.pendingTier2)) return
    await runEvent({ type: "tier2_cancel", requestId: token.requestId, ts: Date.now() }, null, state)
  })
}

/** Fire a nag notification immediately, for manual testing (goal = "알림보기"). Direct mode:
 *  the synthetic pageKey "test" matches no real tab, so the page-bound gate would park it. */
export async function testNag(goal: SessionGoal | null): Promise<void> {
  await deliver({ type: "nag", pageKey: "test" }, goal, Date.now(), null, null, true)
}

const PENDING_WRITER_KEY = "pending-writer"

// --- held nag (D19 delivery gate: 잔소리는 유발한 페이지 위에서만) --------------------

const NAG_HOLD_KEY = "nag-hold"
// TTL anchor is the nag's queue-entry time; judged strictly at every delivery attempt. After
// this, the drift moment the message described is history — the gauge re-nags with fresh
// context if the drift is still real (renag debt), so nothing is silently lost forever.
const NAG_MAX_AGE_MS = 3 * 60_000
// Returning to the page pops the held nag only after a short grace — appearing the instant
// the tab focuses reads as an ambush. Applies ONLY to hold-resume delivery, never normal.
const NAG_HOLD_GRACE_MS = 3_000

// The single durable hold slot: the newest nag that reached delivery while the user was not
// looking at its page (wrong tab/window, or Chrome unfocused/idle). One slot by design —
// an older parked complaint is obsolete the moment a newer one exists.
interface NagHold {
  pageKey: string
  createdAt: number // queue-entry ts of the underlying effect — the TTL anchor
  epoch: number // owning session; any other session must never see it
  writerMessage: string | null
  source: EffectSource | null
}

// In-memory single-flight for the grace timer. Deliberately NOT durable: if the SW dies
// mid-grace the hold record survives, and the next poke (observe / heartbeat, ≤1 min) simply
// re-arms a fresh grace — strictly later, never a double delivery.
let holdGraceArmed = false

/** Entry point for "did the user come back?" signals (observe + the heartbeat backstop).
 *  Cheap when there is nothing held; arms the one grace timer when the active tab is the
 *  held page and the user is present. */
export async function pokeNagHold(goal: SessionGoal): Promise<void> {
  if (holdGraceArmed) return
  // Claim the single flight SYNCHRONOUSLY, before any await: a return navigation fires
  // several observation triggers within milliseconds (onActivated + onUpdated title/complete),
  // and a flag set only after the async checks below would let two of them both pass the
  // check above and arm two grace timers — a double delivery (double chime, double recordNag).
  holdGraceArmed = true
  let armed = false
  try {
    const hold = await kvGet<NagHold>(NAG_HOLD_KEY)
    if (!hold || typeof hold.pageKey !== "string") return
    if (hold.epoch !== goal.epoch || Date.now() - hold.createdAt > NAG_MAX_AGE_MS) {
      await kvDelete(NAG_HOLD_KEY)
      return
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const descriptor = tab?.url ? describeObservableUrl(tab.url) : null
    if (descriptor?.pageKey !== hold.pageKey) return // not back yet — the TTL keeps governing
    if (!(await browserPresent())) return
    // Arm for THIS hold identity. The slot can be re-parked by a NEWER nag while the grace
    // runs (deliver's newest-wins eviction), and the stale timer must then no-op — it may
    // never discard, or deliver, a hold it did not arm for.
    const armedFor = { pageKey: hold.pageKey, createdAt: hold.createdAt }
    armed = true
    const timer = setTimeout(() => {
      void fireHeldNag(armedFor).finally(() => {
        holdGraceArmed = false
      })
    }, NAG_HOLD_GRACE_MS)
    ;(timer as { unref?: () => void }).unref?.()
  } finally {
    if (!armed) holdGraceArmed = false
  }
}

/** End of the grace: re-run EVERY gate (합의안 4) and deliver — or, on ANY failed check,
 *  discard the hold entirely (합의안 3: 유예 중 이탈은 이번 시도 취소가 아니라 보류 소멸).
 *  Everything is scoped to the hold identity this grace was armed for: a slot re-parked by
 *  a newer nag mid-grace is left untouched for its own poke→grace cycle. */
async function fireHeldNag(armedFor: { pageKey: string; createdAt: number }): Promise<void> {
  const isArmedHold = (value: unknown): boolean => {
    const h = value as Partial<NagHold> | undefined
    return h?.pageKey === armedFor.pageKey && h?.createdAt === armedFor.createdAt
  }
  const hold = await kvGet<NagHold>(NAG_HOLD_KEY)
  if (!hold || !isArmedHold(hold)) return // consumed/replaced while the grace ran — not ours
  const discard = () => kvDeleteIf(NAG_HOLD_KEY, isArmedHold) // only ever kill OUR hold
  const now = Date.now()
  const goal = await getGoal()
  if (!goal || goal.epoch !== hold.epoch) return void (await discard())
  if (now - hold.createdAt > NAG_MAX_AGE_MS) return void (await discard())
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const descriptor = tab?.url ? describeObservableUrl(tab.url) : null
  if (descriptor?.pageKey !== hold.pageKey) return void (await discard())
  if (!(await browserPresent())) return void (await discard())
  const settings = await getSettings()
  if (inQuietHours(settings.quietHours, now)) return void (await discard())
  const state = await loadState()
  if (state.snoozedUntil != null && now < state.snoozedUntil) return void (await discard())
  // 판정이 그사이 OK로 뒤집혔다면(관련 있어요 / Tier-2 ok / 재판정) 정당화되지 않는 잔소리.
  if (state.activePageKey === hold.pageKey && state.activeVerdict === "OK") {
    return void (await discard())
  }
  // Atomic take: consume exactly once even against a concurrent deliverer evicting/replacing
  // the slot in the window since the read above — losing the take means it isn't ours to show.
  const taken = await kvTakeIf<NagHold>(NAG_HOLD_KEY, isArmedHold)
  if (!taken) return
  await presentNag(taken.pageKey, goal, taken.createdAt, taken.writerMessage, taken.source)
}

/** Gauge-recovery invalidation (합의안 5): the moment S recovers past rDismiss, or the held
 *  page's own verdict flips OK, the parked nag stopped being justified — empty the slot NOW,
 *  don't wait for a delivery attempt to notice. Recovery is detected as an upward CROSSING,
 *  not a level, so a renag legitimately parked at mid-drain S is not falsely invalidated. */
async function invalidateHoldOnRecovery(
  prev: GaugeState,
  next: GaugeState,
  config: GaugeConfig,
): Promise<void> {
  const okFlip = next.activeVerdict === "OK" && prev.activeVerdict !== "OK"
  const crossed = prev.s < config.rDismiss && next.s >= config.rDismiss
  if (!okFlip && !crossed) return
  const hold = await kvGet<NagHold>(NAG_HOLD_KEY)
  if (!hold) return
  if (crossed || next.activePageKey === hold.pageKey) {
    klog(`held nag invalidated (${crossed ? "gauge recovered" : "verdict flipped OK"})`)
    await kvDelete(NAG_HOLD_KEY)
  }
}

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
  source: EffectSource | null | undefined,
  // testNag ("알림보기") bypasses the page-match/hold machinery: it is a manual smoke test of
  // the presentation path fired against the synthetic pageKey "test", which no real tab can
  // ever match — the D19 gate would silently park it forever instead of showing anything.
  direct = false,
): Promise<void> {
  // request_tier2 is never delivered here — it is a durable job handled by startTier2Job.
  if (effect.type === "nag") {
    const now = Date.now()
    const settings = await getSettings()
    // 원칙 (D19): 잔소리는 그것을 유발한 페이지 위에서만 뜬다. 떠났으면 침묵하고, 드리프트가
    // 계속이면 게이지가 새 맥락으로 다시 말을 건다 — 기억은 토스트가 아니라 게이지가 담당한다.
    if (!direct) {
      // Newest wins: the moment a newer nag reaches delivery, whatever is parked in the hold
      // slot describes an older drift moment — discard it no matter how THIS delivery ends.
      await kvDelete(NAG_HOLD_KEY)
      // Freshness, judged strictly at the delivery moment (TTL anchor = queue-entry time).
      // This also covers the restart flush: a pre-shutdown nag older than 3 minutes never
      // surfaces, whatever page the relaunch restored.
      if (now - ts > NAG_MAX_AGE_MS) {
        klog(`nag dropped (stale, ${Math.round((now - ts) / 1000)}s old)`)
        logEvent("nag", { pageKey: effect.pageKey, suppressed: "ttl" })
        return
      }
    }
    // Do-not-disturb: within quiet hours, drop the nudge entirely (the drift is still
    // logged) — the user configured silence, so no hold either.
    if (inQuietHours(settings.quietHours, now)) {
      klog(`nag suppressed (quiet hours)`)
      logEvent("nag", { pageKey: effect.pageKey, suppressed: "quiet_hours" })
      return
    }
    if (!direct) {
      // The page-match + presence gate. "Away from the page" and "away from Chrome" are the
      // same condition for a page-bound nudge: not looking at the page that caused it. Both
      // park the nag in the single hold slot instead of dropping it — a return within the
      // TTL delivers it after a short grace (pokeNagHold), which fixes the old swallowed-nag
      // cost where an absence-dropped nag still counted for pacing and pushed the next
      // visible nudge a whole backoff cycle out.
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      const descriptor = tab?.url ? describeObservableUrl(tab.url) : null
      if (descriptor?.pageKey !== effect.pageKey || !(await browserPresent())) {
        if (goal == null) return // no session to re-check against later — nothing to hold
        const hold: NagHold = {
          pageKey: effect.pageKey,
          createdAt: ts,
          epoch: goal.epoch,
          writerMessage,
          source: source ?? null,
        }
        await kvSet(NAG_HOLD_KEY, hold)
        klog(`nag held (${descriptor?.pageKey === effect.pageKey ? "absent" : "page mismatch"})`)
        logEvent("nag", { pageKey: effect.pageKey, suppressed: "held" })
        return
      }
    }
    await presentNag(effect.pageKey, goal, ts, writerMessage, source, !direct)
  } else if (effect.type === "celebrate") {
    const now = Date.now()
    // 조용한 시간은 축하도 침묵한다: 토스트만이 아니라 차임까지, 사용자가 정한 무음 시간의
    // 의미는 채널을 가리지 않는다. 폐기(보류 없음) — 재장전 사이클이 다음 기회를 만든다.
    const settings = await getSettings()
    if (inQuietHours(settings.quietHours, now)) {
      klog(`celebrate suppressed (quiet hours)`)
      logEvent("celebrate", { suppressed: "quiet_hours" })
      return
    }
    // D19 (합의안 7): 축하는 pageKey가 아니라 "현재 페이지 판정이 여전히 OK인가"로 게이트.
    // 발화 순간과 배달 사이에 이탈했다면(NEUTRAL/DRIFT) 폐기 — misses acceptable.
    const state = await loadState()
    if (state.activeVerdict !== "OK") {
      klog(`celebrate suppressed (verdict ${state.activeVerdict ?? "NEUTRAL"})`)
      logEvent("celebrate", { suppressed: "not_ok" })
      return
    }
    const goalText = goal?.text ?? "목표"
    // Celebrate in the selected persona's voice; fall back to the plain line.
    const persona = await activePersona()
    const message =
      pickCelebrate(persona, { goal: goalText, returnMinutes: await returnMinutes(ts) }) ??
      `'${goalText}'에 다시 집중하고 있네요 👍`
    await setDriftSince(null)
    klog(`celebrate: "${message.slice(0, 48)}"`)
    logEvent("celebrate", { message })
    await showToast(message, null, "celebration", source)
  }
}

/** The nag presentation path (persona message → toast/OS-notification → history), shared by
 *  the normal delivery and the hold-resume delivery — both arrive here only after passing
 *  every gate. */
async function presentNag(
  pageKey: string,
  goal: SessionGoal | null,
  ts: number,
  writerMessage: string | null,
  source: EffectSource | null | undefined,
  // False only for testNag's synthetic pageKey; every real nag keeps the page-identity check
  // alive through showToast's own late tab re-reads (the last sliver of the D19 hole).
  requirePageMatch = true,
): Promise<void> {
  const goalText = goal?.text ?? "목표"
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
    const pageTitle = page?.title || page?.urlHost || "현재 페이지"
    // `local-pdf` is an opaque identity/host label, not user-facing copy. A local PDF's
    // allowed Chrome tab title should fill both template slots so host-based personas do
    // not tell the user they are looking at a page literally named "local-pdf".
    const pageHost = page?.kind === "local_pdf" ? pageTitle : (page?.urlHost || "현재 페이지")
    const fallback = pickFallback(persona, nagCount, {
      goal: goalText,
      title: pageTitle,
      host: pageHost,
    })
    message = fallback
      ? clampSentences(fallback, persona.maxSentences ?? DEFAULT_MAX_SENTENCES)
      : `'${goalText}' 흐름에서 벗어난 것 같아요. 계속 필요한 곁가지인지 확인해볼까요?`
  }
  klog(`nag (${fromWriter ? "writer" : "fallback"}): "${message.slice(0, 48)}"`)
  logEvent("nag", { pageKey, source: fromWriter ? "writer" : "fallback", message })
  const token = await showToast(message, pageKey, "intervention", source, requirePageMatch)
  if (token != null) {
    await recordNag({ ts, host: page?.urlHost ?? "", token })
  }
}

/** Grab the active tab's body text for the Tier-2 judge — but only if the active tab is
 *  still the page being judged and it isn't sensitive. Null on any mismatch/failure
 *  (the judge then falls back to title-only, as before). */
export async function extractActiveExcerpt(pageKey: string): Promise<string | null> {
  await initDomainLists() // memoized — the user blocklist must be loaded before the drop gate
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || !tab.url) return null
  const descriptor = describeObservableUrl(tab.url)
  if (!descriptor || descriptor.pageKey !== pageKey) return null
  // Chrome's built-in PDF viewer is title-only by policy. Do not even attempt injection:
  // local file contents are outside this feature's permission and disclosure boundary.
  if (descriptor.kind === "local_pdf") return null
  if (shouldDropUrl(tab.url)) return null
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
  requestId: number,
): Promise<void> {
  const token: Tier2Token = { pageKey: effect.pageKey, reason: effect.reason, requestId, epoch: goal?.epoch ?? -1 }
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
  if (!(await effectSourceAllowed(page))) {
    klog(`tier2 cancelled (local-pdf disabled) on ${effect.pageKey}`)
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
  if (!(await effectSourceAllowed(page))) {
    await cancelTier2(token)
    return
  }
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
  }, () => effectSourceAllowed(page))
  if (outcome.cancelled) {
    await cancelTier2(token)
    return
  }
  klog(`tier2 gate (${effect.reason}) on ${effect.pageKey} excerpt=${excerpt?.length ?? 0}c -> ${outcome.flow}`)
  logEvent("tier2", { pageKey: effect.pageKey, reason: effect.reason, flow: outcome.flow, excerpt: excerpt?.length ?? 0 })
  // The judge itself broke (fail-open ate a would-be nag) — tell the user once in a
  // while; the toolbar "!" mark carries the ambient state between alerts.
  if (outcome.providerError) void notifyProviderProblem(outcome.providerError)
  // Apply guarded: dispatchTier2 re-checks (serialized) that the pending slot, goal revision,
  // and active page still match before applying — else it releases the slot (tier2_cancel)
  // with no side effect on whatever page the user is on now. The Writer message is staged
  // durably and bound to the nag effect inside runEvent.
  await dispatchTier2(token, outcome.flow, outcome.flow === "drift" ? outcome.message : null, goal)
}

/** Clicking the alert opens the options page (wired in background's onClicked). */
export const PROVIDER_ALERT_ID = "kibitzer-provider-alert"
const PROVIDER_ALERT_TS_KEY = "kibitzer:provider-alert-ts"
const PROVIDER_ALERT_THROTTLE_MS = 6 * 60 * 60_000

/** OS notification for "the LLM judge is broken, so a nag was swallowed" — throttled
 *  hard (6h) so a dead key doesn't turn into a notification storm, and gated on
 *  presence like every other nudge (never pop over another app). The id deliberately
 *  does NOT start with "kbz-" so the nag feedback handlers ignore it. */
async function notifyProviderProblem(message: string): Promise<void> {
  if (!(await browserPresent())) return
  const stored = await chrome.storage.local.get(PROVIDER_ALERT_TS_KEY)
  const last = typeof stored[PROVIDER_ALERT_TS_KEY] === "number" ? stored[PROVIDER_ALERT_TS_KEY] : 0
  const now = Date.now()
  if (now - last < PROVIDER_ALERT_THROTTLE_MS) return
  await chrome.storage.local.set({ [PROVIDER_ALERT_TS_KEY]: now })
  try {
    chrome.notifications.create(PROVIDER_ALERT_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Kibitzer — AI 판정 오류",
      message: `${message} · 지금은 제목 유사도만으로 판정합니다. 알림을 누르면 설정이 열립니다.`,
    })
  } catch {
    // No notifications permission / platform limit — the toolbar mark still shows.
  }
}

const TOAST_TOKEN_KEY = "toast-token"
const FIRST_NAG_KEY = "first-nag-count" // lifetime intervention-toast counter (첫 훈수 변형)

/** A durable, strictly-increasing display token. In-memory (`let toastToken = 0`) reset to 0
 *  on every service-worker restart, so a post-restart nag reused an id an earlier nag's
 *  recordNag had stored — making markNagActed act on the wrong nag. Persisting it keeps ids
 *  unique across restarts; the atomic kvUpdate keeps them unique under concurrency too (the
 *  test-nag path `testNag` delivers outside the dispatch queue, so a plain get+set could
 *  race a heartbeat delivery and mint a duplicate). */
async function nextToastToken(): Promise<number> {
  return kvUpdate<number>(TOAST_TOKEN_KEY, (current) => (typeof current === "number" ? current : 0) + 1)
}

/** Render the in-page toast overlay in the active tab (matches apps/extension — a quiet
 *  on-page bubble). Injected via executeScript; falls back to an OS notification when the
 *  page can't be injected (chrome://, the web store, PDF viewer, no active tab) so the
 *  nudge is never silently dropped. Returns the displayToken (to log the nag), or null. */
async function showToast(
  message: string,
  contextLabel: string | null,
  kind: "intervention" | "celebration",
  source: EffectSource | null | undefined,
  // D19: for a real nag, contextLabel IS the trigger pageKey and the late tab re-reads below
  // must keep matching it — a tab switch in the milliseconds after deliver()'s gate must not
  // paint page A's complaint over page B. False for celebrations (page-free by design) and
  // testNag's synthetic key.
  requirePageMatch = false,
): Promise<number | null> {
  // Source policy, not the current tab, owns queued work. Missing source metadata on a
  // local-PDF page key is a legacy/fail-closed case.
  if ((contextLabel?.startsWith("local-pdf#") && !source) || !(await effectSourceAllowed(source))) return null
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  // Privacy: never surface a nudge on a sensitive (or user-blocked) page, even if one was
  // queued before the user navigated there. A queued effect can be delivered by a freshly
  // woken worker, so wait for the user lists (memoized) before consulting the gate.
  await initDomainLists()
  const activeDescriptor = tab?.url ? describeObservableUrl(tab.url) : null
  if (activeDescriptor?.kind === "local_pdf" && !(await getSettings()).observeLocalPdfs) return null
  if (activeDescriptor?.kind === "web" && tab?.url && shouldDropUrl(tab.url)) return null
  // Delivery invariant: never surface a nudge (toast, its OS-notification fallback, or the
  // chime) while Chrome isn't being looked at — the user explicitly never wants an OS
  // notification popping over another app. Drop it here (ACKed, no retry — the drift is already
  // logged upstream), mirroring the sensitive-page drop and the quiet-hours suppression. The
  // OS-notification fallback below intentionally REMAINS for non-injectable pages when Chrome
  // IS focused (e.g. the user is literally on chrome://extensions).
  if (!(await browserPresent())) {
    klog(`nag suppressed (browser unfocused)`)
    return null
  }
  if (!(await effectSourceAllowed(source))) return null
  const token = await nextToastToken()
  // Re-read after the async presence/policy/token work. The user may have navigated the same
  // tab (or switched tabs) since the first snapshot; in particular, never inject into a PDF
  // viewer that became active while delivery was being prepared.
  const [deliveryTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const deliveryDescriptor = deliveryTab?.url ? describeObservableUrl(deliveryTab.url) : null
  if (requirePageMatch && deliveryDescriptor?.pageKey !== contextLabel) return null
  if (deliveryDescriptor?.kind === "local_pdf" && !(await getSettings()).observeLocalPdfs) return null
  if (deliveryDescriptor?.kind === "web" && deliveryTab?.url && shouldDropUrl(deliveryTab.url)) return null
  void playChime(kind) // audible cue via the offscreen document (works off-screen)
  // Chrome's built-in PDF viewer may report executeScript success without rendering an
  // overlay in its visible plugin surface. With file access OFF it is not a reliable toast
  // host at all, so route local PDFs directly to the existing OS-notification surface.
  if (deliveryDescriptor?.kind === "local_pdf") {
    if (!(await effectSourceAllowed(source))) return null
    return (await showSystemNotification(token, message, kind)) ? token : null
  }
  if (deliveryTab?.id) {
    if (!(await effectSourceAllowed(source))) return null
    // Take one last active-tab snapshot immediately before injection. If the tab became a
    // PDF meanwhile, never trust a superficially successful executeScript result from
    // Chrome's PDF viewer.
    const [injectionTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const injectionDescriptor = injectionTab?.url ? describeObservableUrl(injectionTab.url) : null
    if (requirePageMatch && injectionDescriptor?.pageKey !== contextLabel) return null
    if (injectionDescriptor?.kind === "local_pdf" && !(await getSettings()).observeLocalPdfs) return null
    if (injectionDescriptor?.kind === "web" && injectionTab?.url && shouldDropUrl(injectionTab.url)) return null
    if (injectionDescriptor?.kind === "local_pdf") {
      return (await showSystemNotification(token, message, kind)) ? token : null
    }
    if (injectionTab?.id) {
      // The first-ever intervention toast renders as a one-time explainer variant (the
      // response buttons and the bubble-click="잘 잡았어요" are not self-evident). Same
      // atomic-kv pattern as the display token. Consumed HERE, past every bail-out above,
      // so an OS-notification fallback (which has no room to explain) doesn't consume the
      // slot — only an injection FAILURE below can, which we accept for one-shot simplicity.
      const firstRun =
        kind === "intervention" &&
        (await kvUpdate<number>(FIRST_NAG_KEY, (c) => (typeof c === "number" ? c : 0) + 1)) === 1
      const payload: ToastPayload = {
        notificationId: `kbz-${token}`,
        displayToken: token,
        message,
        contextLabel,
        autoDismissMs: 12_000,
        kind,
        firstRun,
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: injectionTab.id },
          func: showKibitzerToast,
          args: [payload],
        })
        return token
      } catch {
        // Injection blocked (chrome://, web store, PDF) — fall through to a notification.
      }
    }
  }
  if (!(await effectSourceAllowed(source))) return null
  return (await showSystemNotification(token, message, kind)) ? token : null
}

/** OS-notification fallback for pages that can't host the in-page toast. Buttons feed the
 *  same feedback path as the toast (see background's notifications.onButtonClicked). */
async function showSystemNotification(
  token: number,
  message: string,
  kind: "intervention" | "celebration",
): Promise<boolean> {
  try {
    await chrome.notifications.create(`kbz-${token}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Kibitzer",
      message,
      buttons:
        kind === "intervention" ? [{ title: "목표와 관련 있어요" }, { title: "5분만" }] : [],
    })
    return true
  } catch {
    // No notifications permission / platform limit — nothing more we can do.
    return false
  }
}

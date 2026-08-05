// Browser-restart session policy. A session never expires on its own; what happens when the
// browser is fully quit mid-session and later relaunched is decided HERE, once, on
// chrome.runtime.onStartup (a real browser start — never a mere service-worker wake):
//
//   경우 ① gap ≤ RESTORE_GAP_MS and 자동 유지 ON → the session continues: the reducer clock is
//     rebased so the downtime is never integrated, wall-clock anchors (goal.startedAt, the
//     drift timer) are shifted past the gap, and a one-time popup banner explains the rule.
//   경우 ② longer gap (or 자동 유지 OFF) → the session is parked as a "suspended session"
//     (session.ts): observation stops because getGoal() is null, but the gauge/visit state
//     stays in the SSOT so the popup's "직전 세션 이어가기" can resume it — same epoch,
//     stats intact. Declaring a new goal instead closes it quietly (background.ts).
//
// The gap is measured against a durable last-alive marker the 1-min heartbeat alarm writes:
// ±1 minute of accuracy is plenty for a 5-minute threshold.

import { kvGet, kvSet } from "./db.ts"
import { logEvent } from "./events.ts"
import { klog } from "./klog.ts"
import { clearBadge } from "./badge.ts"
import { disarmCelebrate, purgeQueuedCelebrates, rebaseAfterGap } from "./gaugeRuntime.ts"
import { noteInactive } from "./visits.ts"
import { getSettings } from "./settings.ts"
import {
  getGoal,
  getSuspendedSession,
  resumeSuspendedGoal,
  shiftGoalStart,
  suspendGoal,
  type SessionGoal,
} from "./session.ts"

/** 경우 ① window: a full quit + relaunch within this keeps the session running. */
export const RESTORE_GAP_MS = 5 * 60_000

const LAST_ALIVE_KEY = "last-alive" // kv (IndexedDB) — written by the heartbeat alarm
const NOTICE_KEY = "kibitzer:restore-notice:v1" // 경우 ① banner event (storage.local)
const BANNER_DISMISSED_KEY = "kibitzer:restore-banner-dismissed:v1" // ① "다시 보지 않기"
const HINT_SEEN_KEY = "kibitzer:suspend-hint-seen:v1" // ② setup-view callout, closed once
// A continue-banner the user simply ignored shouldn't stick for the whole session.
const NOTICE_TTL_MS = 30 * 60_000
const POPUP_OPEN_DELAY_MS = 1000
// Fallback for plain SW wakes, where onStartup never fires and the decision never runs.
// Well under the 1-min heartbeat that bounds teardown-recovery latency anyway.
const STARTUP_SETTLE_FALLBACK_MS = 1500

// --- startup barrier ---------------------------------------------------------------

let settleStartup: () => void
let settleFallbackTimer: ReturnType<typeof setTimeout> | null = null
/** Resolves once the restart decision has committed — or after a short fallback on a plain
 *  service-worker wake (no onStartup). Gates every gauge-advancing entry point in
 *  background.ts (module-level outbox flush, heartbeat alarm, observe, get-state): without
 *  it, a replayed heartbeat alarm's noteAlive(now) could mask a multi-day gap as ≈0 (wrongly
 *  continuing the session), an early dispatch/enterNeutral could integrate up to gapCap of
 *  the gap under the pre-shutdown verdict, and with 자동 유지 OFF plus a short gap a young
 *  pre-shutdown nag (too young for the drain TTL) could deliver in the milliseconds before
 *  the suspend stripped its goal. */
export const startupSettled: Promise<void> = new Promise((resolve) => {
  settleStartup = resolve
  settleFallbackTimer = setTimeout(resolve, STARTUP_SETTLE_FALLBACK_MS)
  // Node test environments: don't hold the process open for the fallback.
  ;(settleFallbackTimer as { unref?: () => void }).unref?.()
})

/** Durable "the browser was alive (with a session) at `ts`" marker. Heartbeat-driven. */
export async function noteAlive(ts: number): Promise<void> {
  try {
    await kvSet(LAST_ALIVE_KEY, ts)
  } catch {
    // Best-effort: losing a tick only skews the restart-gap estimate by ≤1 minute.
  }
}

/** The restart policy, isolated for tests: continue only within the window AND opted in. */
export function restoreDecision(gapMs: number, autoContinue: boolean): "continue" | "suspend" {
  return autoContinue && gapMs <= RESTORE_GAP_MS ? "continue" : "suspend"
}

/** The onStartup entry point. Runs BEFORE the startup outbox flush (background.ts) so a
 *  suspend lands before stale pre-shutdown effects could try to deliver; resolves the
 *  startupSettled barrier on every exit path. */
export async function handleBrowserStartup(): Promise<void> {
  // The decision now owns the barrier: a cold start slower than the fallback must NOT
  // re-open the race the barrier exists to close. (Residual: onStartup dispatching later
  // than the fallback after module eval — Chrome fires it immediately at launch, so no.)
  if (settleFallbackTimer != null) clearTimeout(settleFallbackTimer)
  try {
    await decideRestart()
  } finally {
    settleStartup()
  }
}

async function decideRestart(): Promise<void> {
  const goal = await getGoal()
  if (!goal) return
  // 칭찬은 재시작을 넘지 않는다 (D19): a queued celebrate congratulates a recovery arc the
  // shutdown already broke, so a relaunch — continue OR suspend — drops it undelivered.
  // Runs before the startupSettled barrier opens the first drain, so it can't lose the race.
  await purgeQueuedCelebrates()
  const now = Date.now()
  // The marker lags real shutdown by ≤1 heartbeat; a goal declared moments before the quit
  // may have no marker (or an older session's) yet — startedAt bounds the estimate then.
  const lastAlive = Math.max((await kvGet<number>(LAST_ALIVE_KEY)) ?? 0, goal.startedAt)
  const gapMs = Math.max(0, now - lastAlive)
  const settings = await getSettings()
  const decision = restoreDecision(gapMs, settings.sessionAutoContinue)
  logEvent("restore", { decision, gapMinutes: Math.round(gapMs / 60_000) })
  if (decision === "continue") {
    klog(`restore: continuing session across a ${Math.round(gapMs / 1000)}s restart gap`)
    await shiftGoalStart(gapMs)
    void noteInactive(lastAlive, goal.epoch) // close the pre-shutdown visit interval at shutdown time
    await rebaseAfterGap(gapMs, goal)
    if (!(await bannerDismissed())) {
      await chrome.storage.local.set({ [NOTICE_KEY]: { epoch: goal.epoch, at: now, gapMs } })
      scheduleAutoPopup()
    }
  } else {
    klog(`restore: suspending session (gap ${Math.round(gapMs / 60_000)}m, auto=${settings.sessionAutoContinue})`)
    void noteInactive(lastAlive, goal.epoch)
    await suspendGoal(lastAlive, now)
    void clearRestoreNotice() // a leftover continue-banner must not outlive its session's park
    clearBadge() // no live session → no toolbar status
  }
  await noteAlive(now) // an immediate re-quit must measure from THIS launch, not the old marker
}

/** Popup "직전 세션 이어가기": reactivate the suspended session (same epoch — the gauge and
 *  visit stats still belong to it) and absorb the whole downtime like the continue path. */
export async function resumeSuspendedSession(): Promise<SessionGoal | null> {
  const now = Date.now()
  const suspended = await getSuspendedSession()
  if (!suspended) return null
  const goal = await resumeSuspendedGoal(now)
  if (!goal) return null
  const downMs = Math.max(0, now - suspended.downFrom)
  await rebaseAfterGap(downMs, goal)
  // 새로 브라우저를 열고 아직 딱히 한 것도 없는데 다짜고짜 칭찬 메시지가 뜨는 것을 지양:
  // 보류 전 어중간하게 장전된(20↓ 후 20~80 사이에서 멈춘) 축하 아크는 여기서 끊는다.
  // 깊은 drift(S ≤ cArm)로 보류된 세션은 재개 후 첫 적분 틱에 자연 재장전되므로, 재개 후에
  // 실제로 일어난 회복은 여전히 칭찬받는다 (disarmCelebrate 주석 참고).
  await disarmCelebrate()
  await noteAlive(now)
  // Same epoch comes back alive — a continue-banner queued before the park (still within its
  // TTL) would otherwise reappear over a manually resumed session and misexplain what happened.
  await clearRestoreNotice()
  logEvent("restore", { decision: "resume", downMinutes: Math.round(downMs / 60_000) })
  klog(`restore: resumed session epoch=${goal.epoch} after ${Math.round(downMs / 60_000)}m parked`)
  return goal
}

// --- 경우 ① banner (popup) ----------------------------------------------------------

export interface RestoreNotice {
  epoch: number
  at: number
  gapMs: number
}

async function bannerDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get(BANNER_DISMISSED_KEY)
  return Boolean(stored[BANNER_DISMISSED_KEY])
}

/** The pending continue-banner for the CURRENT session, or null (dismissed, expired,
 *  another epoch's leftovers). */
export async function getRestoreNotice(goal: SessionGoal | null): Promise<RestoreNotice | null> {
  if (!goal) return null
  if (await bannerDismissed()) return null
  const stored = await chrome.storage.local.get(NOTICE_KEY)
  const value = stored[NOTICE_KEY] as Partial<RestoreNotice> | undefined
  if (!value || typeof value.at !== "number" || value.epoch !== goal.epoch) return null
  if (Date.now() - value.at > NOTICE_TTL_MS) return null
  return { epoch: value.epoch, at: value.at, gapMs: typeof value.gapMs === "number" ? value.gapMs : 0 }
}

export async function clearRestoreNotice(): Promise<void> {
  await chrome.storage.local.remove(NOTICE_KEY)
}

/** ① "다시 보지 않기" — the banner (and its auto-popup) never returns. */
export async function dismissRestoreBannerForever(): Promise<void> {
  await chrome.storage.local.set({ [BANNER_DISMISSED_KEY]: Date.now() })
  await clearRestoreNotice()
}

// --- 경우 ② one-time setup-view callout ----------------------------------------------

export async function isSuspendHintSeen(): Promise<boolean> {
  const stored = await chrome.storage.local.get(HINT_SEEN_KEY)
  return Boolean(stored[HINT_SEEN_KEY])
}

export async function markSuspendHintSeen(): Promise<void> {
  await chrome.storage.local.set({ [HINT_SEEN_KEY]: Date.now() })
}

/** Surface the continue-banner without waiting for the user to find the popup: open it
 *  shortly after launch. openPopup needs Chrome 127+ and an active browser window — on any
 *  failure the banner simply waits for the next manual open. */
function scheduleAutoPopup(): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await (chrome.action as { openPopup?: () => Promise<void> }).openPopup?.()
      } catch (error) {
        klog(`restore: openPopup unavailable (${String(error)})`)
      }
    })()
  }, POPUP_OPEN_DELAY_MS)
  // Node test environments: don't hold the process open for a cosmetic timer.
  ;(timer as { unref?: () => void }).unref?.()
}

// The declared goal for the current session, owned by the extension (no server).

import { truncateCodePoints } from "../providers/judgeParsing.ts"

const GOAL_KEY = "kibitzer:goal:v1"
// A session parked by the browser-restart policy (sessionRestore.ts): the goal record moves
// here so getGoal() returns null — every observe/heartbeat/dwell path stops on its existing
// goal guard — while the gauge state, visit tracker, and nag history stay untouched in the
// SSOT for a later "이어가기" (which simply moves the goal back, same epoch).
const SUSPENDED_KEY = "kibitzer:suspended-session:v1"
// The goal text is embedded verbatim in every cloud payload (Tier-1/2, session summary), so it
// must be bounded at ingress — nothing upstream guarantees a cap (the popup input can be pasted
// into, and any extension page can set-goal via message). Clamped on read too, so values stored
// before this cap existed can't bypass it.
export const GOAL_MAX_CHARS = 2000
// A strictly-monotonic counter that survives goal clears — see `epoch` below.
const EPOCH_KEY = "kibitzer:goal-epoch:v1"

export interface SessionGoal {
  text: string
  availableMinutes: number | null
  startedAt: number
  // Monotonic within a goal's life; bumped whenever text OR available-minutes changes. Used
  // for in-session change detection. Resets to 0 when a goal is cleared+redeclared.
  revision: number
  // Strictly monotonic across the whole extension lifetime — never reset by a goal clear, so
  // it uniquely identifies a session. Async work (Tier-2 jobs) captures the epoch and is
  // dropped if it no longer matches, which `revision` alone can't guarantee across a
  // clear→redeclare (revision would be 0 again).
  epoch: number
}

function nowMs(): number {
  return Date.now()
}

/** Increment and persist the durable epoch counter, returning the new value. */
async function bumpEpoch(): Promise<number> {
  const stored = await chrome.storage.local.get(EPOCH_KEY)
  const current = typeof stored[EPOCH_KEY] === "number" ? stored[EPOCH_KEY] : 0
  const next = current + 1
  await chrome.storage.local.set({ [EPOCH_KEY]: next })
  return next
}

function coerceGoal(value: Partial<SessionGoal> | undefined): SessionGoal | null {
  if (!value || typeof value.text !== "string" || !value.text.trim()) return null
  return {
    text: truncateCodePoints(value.text, GOAL_MAX_CHARS),
    availableMinutes: typeof value.availableMinutes === "number" ? value.availableMinutes : null,
    startedAt: typeof value.startedAt === "number" ? value.startedAt : nowMs(),
    revision: typeof value.revision === "number" ? value.revision : 0,
    epoch: typeof value.epoch === "number" ? value.epoch : 0,
  }
}

export async function getGoal(): Promise<SessionGoal | null> {
  const stored = await chrome.storage.local.get(GOAL_KEY)
  return coerceGoal(stored[GOAL_KEY] as Partial<SessionGoal> | undefined)
}

// Serialize all goal mutations so their read-modify-write (of the goal AND the durable epoch
// counter) is linearized — two concurrent setGoal calls (e.g. a double-clicked popup button)
// must get distinct, ordered epochs, not both read the same pre-increment value.
let mutationQueue: Promise<unknown> = Promise.resolve()
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(op, op)
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Set (or clear, when text is empty) the session goal. Bumps `revision` and the durable
 *  `epoch` when either the text or the available-minutes changes. Serialized. */
export function setGoal(text: string, availableMinutes: number | null): Promise<SessionGoal | null> {
  return serialize(async () => {
    const trimmed = truncateCodePoints(text.trim(), GOAL_MAX_CHARS)
    if (!trimmed) {
      await chrome.storage.local.remove(GOAL_KEY)
      return null
    }
    const previous = await getGoal()
    const changed =
      !previous || previous.text !== trimmed || previous.availableMinutes !== availableMinutes
    const goal: SessionGoal = {
      text: trimmed,
      availableMinutes,
      startedAt: changed ? nowMs() : previous.startedAt,
      revision: changed ? (previous?.revision ?? -1) + 1 : previous.revision,
      epoch: changed ? await bumpEpoch() : previous.epoch,
    }
    await chrome.storage.local.set({ [GOAL_KEY]: goal })
    return goal
  })
}

// --- browser-restart suspension (sessionRestore.ts owns the policy) ----------------

export interface SuspendedSession {
  goal: SessionGoal
  suspendedAt: number // when the suspend decision ran (the relaunch that parked it)
  downFrom: number // ≈ when the browser was last alive — the session's effective stop time
}

export async function getSuspendedSession(): Promise<SuspendedSession | null> {
  const stored = await chrome.storage.local.get(SUSPENDED_KEY)
  const value = stored[SUSPENDED_KEY] as Partial<SuspendedSession> | undefined
  const goal = coerceGoal(value?.goal)
  if (!goal || typeof value?.suspendedAt !== "number" || typeof value?.downFrom !== "number") {
    return null
  }
  return { goal, suspendedAt: value.suspendedAt, downFrom: value.downFrom }
}

/** Park the active goal as a suspended session (serialized). No-op → null without a goal. */
export function suspendGoal(downFrom: number, now: number): Promise<SuspendedSession | null> {
  return serialize(async () => {
    const goal = await getGoal()
    if (!goal) return null
    const record: SuspendedSession = { goal, suspendedAt: now, downFrom }
    await chrome.storage.local.set({ [SUSPENDED_KEY]: record })
    await chrome.storage.local.remove(GOAL_KEY)
    return record
  })
}

/** Reactivate the suspended session as the live goal — SAME epoch/revision, so the gauge
 *  state, visit tracker, and epoch-guarded async work all still belong to it. startedAt is
 *  shifted past the downtime so wall-clock elapsed views (sundial, time budget) don't count
 *  time the browser was closed. Never clobbers an already-active goal. */
export function resumeSuspendedGoal(now: number): Promise<SessionGoal | null> {
  return serialize(async () => {
    const suspended = await getSuspendedSession()
    if (!suspended) return null
    if (await getGoal()) return null
    const downtime = Math.max(0, now - suspended.downFrom)
    const goal: SessionGoal = {
      ...suspended.goal,
      startedAt: Math.min(suspended.goal.startedAt + downtime, now),
    }
    await chrome.storage.local.set({ [GOAL_KEY]: goal })
    await chrome.storage.local.remove(SUSPENDED_KEY)
    return goal
  })
}

/** Remove and return the suspended session (for the quiet close when a NEW goal replaces
 *  it instead of resuming). Serialized so it can't race a concurrent resume. */
export function takeSuspendedSession(): Promise<SuspendedSession | null> {
  return serialize(async () => {
    const suspended = await getSuspendedSession()
    if (!suspended) return null
    await chrome.storage.local.remove(SUSPENDED_KEY)
    return suspended
  })
}

/** Shift the live goal's startedAt forward by `deltaMs` (restart-continue path): the
 *  downtime must not count toward the declared time budget. Epoch/revision untouched. */
export function shiftGoalStart(deltaMs: number): Promise<SessionGoal | null> {
  return serialize(async () => {
    const goal = await getGoal()
    if (!goal || deltaMs <= 0) return goal
    const shifted: SessionGoal = {
      ...goal,
      startedAt: Math.min(goal.startedAt + deltaMs, nowMs()),
    }
    await chrome.storage.local.set({ [GOAL_KEY]: shifted })
    return shifted
  })
}

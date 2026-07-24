// The declared goal for the current session, owned by the extension (no server).

const GOAL_KEY = "kibitzer:goal:v1"
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

export async function getGoal(): Promise<SessionGoal | null> {
  const stored = await chrome.storage.local.get(GOAL_KEY)
  const value = stored[GOAL_KEY] as Partial<SessionGoal> | undefined
  if (!value || typeof value.text !== "string" || !value.text.trim()) return null
  return {
    text: value.text,
    availableMinutes: typeof value.availableMinutes === "number" ? value.availableMinutes : null,
    startedAt: typeof value.startedAt === "number" ? value.startedAt : nowMs(),
    revision: typeof value.revision === "number" ? value.revision : 0,
    epoch: typeof value.epoch === "number" ? value.epoch : 0,
  }
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
    const trimmed = text.trim()
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

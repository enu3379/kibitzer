// The declared goal for the current session, owned by the extension (no server).

const GOAL_KEY = "kibitzer:goal:v1"

export interface SessionGoal {
  text: string
  availableMinutes: number | null
  startedAt: number
  // Monotonic; bumped whenever text OR available-minutes changes. Async work (Tier-2
  // judgements) captures the revision and is dropped if the goal moved on meanwhile.
  revision: number
}

function nowMs(): number {
  return Date.now()
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
  }
}

/** Set (or clear, when text is empty) the session goal. Bumps `revision` when either the
 *  text or the available-minutes changes. Returns the stored goal. */
export async function setGoal(text: string, availableMinutes: number | null): Promise<SessionGoal | null> {
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
  }
  await chrome.storage.local.set({ [GOAL_KEY]: goal })
  return goal
}

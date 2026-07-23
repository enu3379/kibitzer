// The declared goal for the current session, owned by the extension (no server).

const GOAL_KEY = "kibitzer:goal:v1"

export interface SessionGoal {
  text: string
  availableMinutes: number | null
  startedAt: number
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
  }
}

/** Set (or clear, when text is empty) the session goal. Returns the stored goal. */
export async function setGoal(text: string, availableMinutes: number | null): Promise<SessionGoal | null> {
  const trimmed = text.trim()
  if (!trimmed) {
    await chrome.storage.local.remove(GOAL_KEY)
    return null
  }
  const goal: SessionGoal = { text: trimmed, availableMinutes, startedAt: nowMs() }
  await chrome.storage.local.set({ [GOAL_KEY]: goal })
  return goal
}

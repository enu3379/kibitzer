import type { CurrentSession, SessionState, SessionStats } from "../lib/api"

export interface DashboardSnapshot {
  state: SessionState
  goalText: string
  stats: SessionStats
}

export interface CompleteDashboard {
  snapshot: DashboardSnapshot
  availableTimeMinutes: number | null
}

export function completeDashboardSnapshot(
  state: SessionState,
  current: CurrentSession | null,
  stats: SessionStats | null,
): CompleteDashboard | null {
  if (!current?.goal || !stats) return null

  const snapshot = {
    state,
    goalText: current.goal.raw_text,
    stats,
  }
  return {
    snapshot,
    availableTimeMinutes: current.goal.available_time_minutes ?? null,
  }
}

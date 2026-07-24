// Toolbar action badge — an at-a-glance status without opening the popup (the
// serverless analog of the old extension's applyStatusIcon / the tray dot). Driven from
// the gauge state on every dispatch.

import type { GaugeState } from "../core/gauge/types.ts"
import type { SessionGoal } from "./session.ts"

const GREEN = "#1f9d6b" // focused
const AMBER = "#e0a100" // slipping
const RED = "#d1495b" // drifting
const GREY = "#8a8a90" // snoozed

export function updateBadge(state: GaugeState, goal: SessionGoal | null, now: number): void {
  if (!goal) return clearBadge()
  let color = GREEN
  if (state.snoozedUntil && state.snoozedUntil > now) color = GREY
  else if (state.s < 33) color = RED
  else if (state.s < 66) color = AMBER
  try {
    void chrome.action.setBadgeText({ text: "●" })
    void chrome.action.setBadgeBackgroundColor({ color })
  } catch {
    // action API unavailable — nothing to do.
  }
}

export function clearBadge(): void {
  try {
    void chrome.action.setBadgeText({ text: "" })
  } catch {
    // ignore
  }
}

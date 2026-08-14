// Shared "is the user actually looking at Chrome?" check, used by the gauge heartbeat
// (background.ts) and enforced again at nudge-delivery time (gaugeRuntime.showToast).
//
// True only when a Chrome window has OS focus AND the user is active. chrome.idle is
// system-wide (idle stays "active" while the user works in another app), so presence must
// ALSO require Chrome to be the focused window — otherwise S drains, nags fire, and OS
// notifications pop while Chrome is off-screen. Unknown → assume present (never over-suppress
// the gauge, never silently wedge a nudge).
export async function browserPresent(): Promise<boolean> {
  try {
    const win = await chrome.windows.getLastFocused()
    if (!win.focused) return false
    return (await chrome.idle.queryState(60)) === "active"
  } catch {
    return true
  }
}

/** True iff `windowId` is the currently focused Chrome window. Tab.active is PER-WINDOW
 *  ("does not necessarily mean the window is focused"), so with two Chrome windows BOTH have
 *  an active tab — observation listeners must additionally check that the tab's window is the
 *  focused one, or a side window's churning page steals the single dwell checkpoint. Unknown →
 *  assume yes (never over-suppress), matching browserPresent's philosophy. */
export async function isFocusedWindow(windowId: number): Promise<boolean> {
  try {
    const win = await chrome.windows.getLastFocused()
    return win.focused === true && win.id === windowId
  } catch {
    return true
  }
}

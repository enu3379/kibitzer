// browserPresent gates every gauge drain AND every nudge delivery, and isFocusedWindow scopes
// the observation surface to the focused window's active tab, so their definitions must hold
// exactly. presence.ts only touches chrome.windows/chrome.idle, stubbed in-memory here
// (mirrors session.test.ts).

import assert from "node:assert/strict"
import test from "node:test"

let focused = true
let focusedWindowId = 1
let idleState: "active" | "idle" | "locked" = "active"
let throwOnQuery = false
;(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: {
    getLastFocused: async () => {
      if (throwOnQuery) throw new Error("no last-focused window")
      return { focused, id: focusedWindowId }
    },
  },
  idle: { queryState: async (_secs: number) => idleState },
}

const { browserPresent, isFocusedWindow } = await import("./presence.ts")

test("present only when a Chrome window is focused AND the user is active", async () => {
  focused = true
  idleState = "active"
  throwOnQuery = false
  assert.equal(await browserPresent(), true)
})

test("absent when no Chrome window is focused (idle is system-wide, so focus must gate too)", async () => {
  focused = false
  idleState = "active"
  assert.equal(await browserPresent(), false)
})

test("absent when the user is idle even while Chrome is focused", async () => {
  focused = true
  idleState = "idle"
  assert.equal(await browserPresent(), false)
})

test("absent when the machine is locked", async () => {
  focused = true
  idleState = "locked"
  assert.equal(await browserPresent(), false)
})

test("unknown → assume present (never over-suppress the gauge or wedge a nudge silent)", async () => {
  throwOnQuery = true
  assert.equal(await browserPresent(), true)
})

test("isFocusedWindow: true for the focused window's own id", async () => {
  focused = true
  focusedWindowId = 7
  throwOnQuery = false
  assert.equal(await isFocusedWindow(7), true)
})

test("isFocusedWindow: false for another window's id (Tab.active is per-window — id must match)", async () => {
  focused = true
  focusedWindowId = 7
  assert.equal(await isFocusedWindow(8), false)
})

test("isFocusedWindow: false when Chrome is entirely unfocused, even for the matching id", async () => {
  focused = false
  focusedWindowId = 7
  assert.equal(await isFocusedWindow(7), false)
})

test("isFocusedWindow: unknown → assume yes (never over-suppress observation)", async () => {
  throwOnQuery = true
  assert.equal(await isFocusedWindow(999), true)
})

import assert from "node:assert/strict"
import test from "node:test"
import type { GaugeState } from "../core/gauge/types.ts"
import type { SessionGoal } from "./session.ts"

// Node has no OffscreenCanvas, so badge.ts takes the native-badge fallback — every render
// lands as a chrome.action.setBadgeText call, which is the whole test seam.
const badgeTexts: string[] = []
let getImpl: () => Promise<Record<string, unknown>> = async () => ({})
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: () => getImpl(),
      set: async () => {},
      remove: async () => {},
    },
  },
  action: {
    setBadgeText: async ({ text }: { text: string }) => void badgeTexts.push(text),
    setBadgeBackgroundColor: async () => {},
  },
}

const { clearBadge, updateBadge } = await import("./badge.ts")

const TIER2_KEY = "kibitzer:provider-health:tier2:v2"
const state = { s: 80, snoozedUntil: null } as unknown as GaugeState
const goal = { text: "목표" } as unknown as SessionGoal

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

test("a health lookup that resolves late must not repaint over a newer badge state", async () => {
  badgeTexts.length = 0
  // Older dispatch: its health read hangs, and would paint an error "!" once released.
  let release: () => void = () => {}
  getImpl = () =>
    new Promise((resolve) => {
      release = () => resolve({ [TIER2_KEY]: { ok: false, kind: "auth", message: "x", ts: Date.now() } })
    })
  updateBadge(state, goal, Date.now())
  // Newer dispatch: healthy — plain status dot, no mark.
  getImpl = async () => ({})
  updateBadge(state, goal, Date.now())
  await settle()
  assert.deepEqual(badgeTexts, ["●"], "only the newest dispatch renders")
  release() // the stale lookup lands late…
  await settle()
  assert.deepEqual(badgeTexts, ["●"], "…and must be dropped, not painted as a stale error mark")
})

test("clearBadge invalidates a pending health lookup", async () => {
  badgeTexts.length = 0
  let release: () => void = () => {}
  getImpl = () =>
    new Promise((resolve) => {
      release = () => resolve({ [TIER2_KEY]: { ok: false, kind: "auth", message: "x", ts: Date.now() } })
    })
  updateBadge(state, goal, Date.now())
  clearBadge()
  await settle()
  release()
  await settle()
  assert.deepEqual(badgeTexts, [""], "a cleared badge stays cleared")
})

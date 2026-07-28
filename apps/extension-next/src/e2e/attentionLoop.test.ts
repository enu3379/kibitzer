// End-to-end integration test: drives the REAL service worker (background.ts) through a
// chrome mock + fake-indexeddb + real KoEn-E5 WASM embeddings, exercising the whole
// attention-guard loop — declare a goal, drift onto an off-goal page, drain S to 0, and
// deliver a nag — none of which the pure/unit tests cover. Degraded (no Ollama) so it needs
// no network: the S=0 gate nags directly.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Serve the real embedding assets off disk so the KoEn-E5 WASM session loads (the extension
// fetches them via chrome.runtime.getURL + globalThis.fetch).
const extRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) // …/apps/extension-next
const assetDisk = (path: string): string =>
  path === "assets/ort/ort-wasm-simd-threaded.wasm"
    ? join(extRoot, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm")
    : join(extRoot, path)
const realFetch = globalThis.fetch
;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url.startsWith("file://")) return new Response(readFileSync(fileURLToPath(url)))
  return realFetch(input as string)
}) as typeof fetch

// --- chrome mock (must be installed BEFORE background.ts is imported) ---------------------
const listeners: Record<string, Array<(...a: unknown[]) => unknown>> = {}
const evt = (name: string) => {
  listeners[name] ??= []
  return { addListener: (fn: (...a: unknown[]) => unknown) => listeners[name].push(fn), removeListener() {} }
}
const store = new Map<string, unknown>() // backs chrome.storage.local
let activeTab: { id: number; url: string; title: string; active: boolean; windowId: number } | null = null
const toasts: Array<Record<string, unknown>> = [] // captured injected toast payloads
const notifications: Array<{ id: string; opts: Record<string, unknown> }> = []
// Presence knobs (browserPresent = Chrome focused AND idle-active). Default present, so the
// existing scenarios are unaffected; the presence-gate scenario flips these and restores them.
let winFocused = true
let idleActive = true

const chrome = {
  tabs: {
    onUpdated: evt("tabs.onUpdated"),
    onActivated: evt("tabs.onActivated"),
    query: async () => (activeTab ? [activeTab] : []),
    get: async () => activeTab,
    create: async () => ({}),
  },
  webNavigation: { onHistoryStateUpdated: evt("wn") },
  runtime: {
    onInstalled: evt("runtime.onInstalled"),
    onStartup: evt("runtime.onStartup"),
    onMessage: evt("runtime.onMessage"),
    // Model/tokenizer → file:// (served by the fetch override below). The ORT runtime wasm →
    // "" so the provider skips `ort.env.wasm.wasmPaths` and ORT uses its node default resolver
    // (the same path tier0Wasm.test.ts relies on), which finds it in node_modules.
    getURL: (p: string) => (p === "assets/ort/ort-wasm-simd-threaded.wasm" ? "" : pathToFileURL(assetDisk(p)).href),
    sendMessage: async () => {},
  },
  alarms: { onAlarm: evt("alarms.onAlarm"), create: async () => {}, get: async () => undefined, clear: async () => {} },
  idle: { onStateChanged: evt("idle"), setDetectionInterval() {}, queryState: async () => (idleActive ? "active" : "idle") },
  // The focused window is always id 1 in these scenarios; tabs of a second (unfocused) side
  // window carry windowId 2 and must be ignored by the observation surface (Fix 4).
  windows: { onFocusChanged: evt("win"), getLastFocused: async () => ({ focused: winFocused, id: 1 }), WINDOW_ID_NONE: -1 },
  notifications: {
    onButtonClicked: evt("nb"),
    onClicked: evt("nc"),
    create: (id: string, opts: Record<string, unknown>) => notifications.push({ id, opts }),
    clear: async () => {},
  },
  scripting: {
    executeScript: async ({ args }: { args?: unknown[] }) => {
      const payload = args?.[0]
      if (payload && typeof payload === "object" && "message" in payload) toasts.push(payload as Record<string, unknown>)
      return [{ result: undefined }]
    },
  },
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (obj: Record<string, unknown>) => void Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
      remove: async (key: string) => void store.delete(key),
    },
  },
  offscreen: { createDocument: async () => {}, hasDocument: async () => true, closeDocument: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
}
;(globalThis as unknown as { chrome: unknown }).chrome = chrome

// Quiet the SW's [kbz] diagnostic logging so it doesn't flood the test output (errors kept).
console.log = () => {}
console.debug = () => {}

// Import the real SW (registers its listeners on the mock above).
await import("../background.ts")

// --- drivers -----------------------------------------------------------------------------
const send = (msg: unknown): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    for (const fn of listeners["runtime.onMessage"]) fn(msg, {}, resolve as (r: unknown) => void)
  })
const fireStartup = async () => {
  for (const fn of listeners["runtime.onStartup"]) await fn()
}
const fireHeartbeat = async () => {
  for (const fn of listeners["alarms.onAlarm"]) await fn({ name: "kibitzer-next-heartbeat" })
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms)) // real timer (only Date is mocked)

test("E2E: goal → drift on an off-goal page → S drains to 0 → nag delivered", async () => {
  mock.timers.enable({ apis: ["Date"] }) // advanceable Date; real setTimeout for WASM + dwell
  try {
    // The user is on a clearly off-goal page and declares a coding goal.
    activeTab = { id: 1, url: "https://video.test/watch?v=cat", title: "귀여운 고양이 영상 몰아보기", active: true, windowId: 1 }
    const setRes = await send({ type: "set-goal", goal: "파이썬 알고리즘 문제 풀이", minutes: null })
    assert.ok((setRes.goal as { text?: string })?.text, "goal was declared")
    await settle(50) // let the fire-and-forget observeActiveTab schedule the dwell

    // The dwell hasn't elapsed in real time; advance the mocked clock past it and let the
    // wake-time reconcile do the judgement (avoids a real 5s wait).
    mock.timers.tick(6000)
    await fireStartup()
    // The KoEn-E5 embed finishes on a REAL timer; a fixed settle() flaked on loaded CI when the
    // judgement landed mid-drain and corrupted the mocked-Date timeline (S bottomed out via a
    // chaotic path that fired celebrations instead of the S=0 nag). Block instead — in real time,
    // nudging the mocked clock only enough to integrate — until the off-goal page has actually
    // been judged DRIFT and S has begun to drain, so the drain loop below starts deterministically.
    let drifting = false
    for (let i = 0; i < 80 && !drifting; i += 1) {
      await settle(100) // real time: let the WASM embed make progress
      mock.timers.tick(5000) // mocked time: only drains once the DRIFT verdict is live
      const s = (await send({ type: "get-state" })).s as number
      drifting = s < 100 || toasts.some((t) => t.kind === "intervention") || notifications.length > 0
    }
    assert.ok(drifting, "the off-goal page was judged DRIFT and S began to drain")

    // A verdict for the off-goal page should now be live and drifting.
    const mid = await send({ type: "get-state" })
    assert.equal((mid.goal as { text?: string })?.text, "파이썬 알고리즘 문제 풀이")
    assert.ok(typeof mid.s === "number" && (mid.s as number) <= 100, `S present: ${mid.s}`)

    // Drive heartbeats (synthetic 1-min steps) until the gauge bottoms out and nags.
    let nagged = false
    for (let i = 0; i < 120 && !nagged; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
      nagged = toasts.some((t) => t.kind === "intervention") || notifications.length > 0
    }

    const final = await send({ type: "get-state" })
    assert.ok(nagged, `a nag was delivered once S drained (final S=${final.s}, toasts=${toasts.length})`)
    assert.equal(final.s, 0, "S bottomed out at 0")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: a sensitive page is dropped — never judged, no drain, no nag (P0-1 privacy)", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Fresh session on a neutral page (a distinct goal → resetState wipes the prior scenario).
    activeTab = { id: 2, url: "https://example.test/neutral", title: "중립 페이지", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "분기 보고서 작성", minutes: null })
    await settle(50)

    // Navigate to a SENSITIVE page (a bank). observe() must drop it before any judging.
    activeTab = { id: 2, url: "https://chase.com/account/summary", title: "Account Summary", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onUpdated"]) await fn(2, { status: "complete" }, activeTab)
    await settle(50)

    // Try hard to make it judge — advance past a dwell and reconcile. There is no checkpoint
    // (the sensitive page scheduled none), so nothing is judged.
    mock.timers.tick(6000)
    await fireStartup()
    await settle(300)
    for (let i = 0; i < 10; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
    }

    const st = await send({ type: "get-state" })
    assert.equal(st.s, 100, "a sensitive page pauses the gauge — S must not drain")
    assert.equal(toasts.length + notifications.length, 0, "no nag is ever surfaced for a sensitive page")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: drifting, then navigating to a new page freezes S — no drain on the page just left", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Fresh session on a clearly off-goal page (a distinct goal → resetState wipes scenario 2).
    activeTab = { id: 3, url: "https://video.test/watch?v=cat", title: "귀여운 고양이 영상 몰아보기", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "파이썬 알고리즘 문제 풀이", minutes: null })
    await settle(50)

    // Judge the off-goal page → DRIFT (advance the clock past the dwell, reconcile does the judge).
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200) // real time for the KoEn-E5 WASM embedding

    // Drain a while on the drifting page — stop well before 0 so the freeze below is non-trivial
    // and can't be confused with S already bottoming out.
    let drained = 100
    for (let i = 0; i < 60 && drained > 50; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
      drained = (await send({ type: "get-state" })).s as number
    }
    assert.ok(drained > 0 && drained < 100, `the drift drained S off full but not to 0 (S=${drained})`)

    // Navigate to a NEW page. observe() enters NEUTRAL immediately; its dwell is a real 5s timer
    // that is never advanced or reconciled here, so the page stays UNjudged — and the gauge must
    // HOLD, not keep draining on the off-goal page's now-stale DRIFT (the pre-fix bug).
    activeTab = { id: 3, url: "https://docs.python.org/3/tutorial/", title: "파이썬 알고리즘 문제 풀이 튜토리얼", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onUpdated"]) await fn(3, { status: "complete" }, activeTab)
    await settle(50)
    const atNav = (await send({ type: "get-state" })).s as number

    // Fifteen minutes of heartbeats while the new page is still in its dwell — S is frozen.
    for (let i = 0; i < 15; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
    }
    const held = (await send({ type: "get-state" })).s as number
    assert.equal(held, atNav, "S is held steady while the new page is judged — no drain on the stale verdict")
    assert.ok(held > 0, "the stale DRIFT did NOT drain S to 0 during the neutral hold")
    assert.equal(toasts.length + notifications.length, 0, "no nag fires during the neutral hold")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: opening an internal page (chrome://newtab) holds S — no drain on the page just left (Fix 1)", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Fresh session on a clearly off-goal page (a distinct goal → resetState wipes the prior scenario).
    activeTab = { id: 5, url: "https://video.test/watch?v=dog", title: "귀여운 강아지 영상 몰아보기", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "리액트 컴포넌트 리팩터링", minutes: null })
    await settle(50)

    // Judge the off-goal page → DRIFT (advance past the dwell, reconcile does the judge).
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200) // real time for the KoEn-E5 WASM embedding

    // Drain a while, stopping well before 0 so the freeze below is unambiguous.
    let drained = 100
    for (let i = 0; i < 60 && drained > 50; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
      drained = (await send({ type: "get-state" })).s as number
    }
    assert.ok(drained > 0 && drained < 100, `the drift drained S off full but not to 0 (S=${drained})`)

    // Open a new tab: an internal chrome:// page with NO page key. Pre-fix, observe() returned at
    // `if (!pageKey) return` BEFORE the neutral hold, so heartbeats kept draining the off-goal
    // page's now-stale DRIFT while the user sat on a blank tab. Post-fix it holds NEUTRAL.
    activeTab = { id: 5, url: "chrome://newtab/", title: "New Tab", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onUpdated"]) await fn(5, { status: "complete" }, activeTab)
    await settle(50)
    const atNav = (await send({ type: "get-state" })).s as number

    // Fifteen minutes of heartbeats while sitting on the new tab — S must be frozen.
    for (let i = 0; i < 15; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
    }
    const held = (await send({ type: "get-state" })).s as number
    assert.equal(held, atNav, "the internal page holds the gauge NEUTRAL — no drain on the stale verdict")
    assert.ok(held > 0, "the stale DRIFT did NOT drain S to 0 while on the new tab")
    assert.equal(toasts.length + notifications.length, 0, "no nag fires while holding on the internal page")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: a nag is never surfaced while Chrome is unfocused, but delivers once focused (Fix 3)", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    activeTab = { id: 6, url: "https://example.test/article", title: "예시 문서", active: true, windowId: 1 }

    // Chrome is NOT the focused app. The test-goal "알림보기" fires a nag immediately (testNag),
    // but the delivery invariant in showToast must drop it — no toast, no OS notification.
    winFocused = false
    await send({ type: "set-goal", goal: "알림보기", minutes: null })
    await settle(50)
    assert.equal(toasts.length + notifications.length, 0, "no nudge surfaces while Chrome is unfocused")

    // The user is at the keyboard but Chrome is still not focused (idle system-wide is "active"):
    // presence still requires window focus, so the nudge stays suppressed.
    idleActive = true
    await send({ type: "set-goal", goal: "알림보기", minutes: null })
    await settle(50)
    assert.equal(toasts.length + notifications.length, 0, "focus, not just idle-active, gates delivery")

    // Chrome regains focus: the OS-fallback/toast is only presence-gated, not disabled, so the
    // same path now delivers.
    winFocused = true
    await send({ type: "set-goal", goal: "알림보기", minutes: null })
    await settle(50)
    assert.ok(toasts.length + notifications.length > 0, "the nudge delivers once Chrome is focused again")
  } finally {
    winFocused = true
    idleActive = true
    mock.timers.reset()
  }
})

test("E2E: title churn in an UNFOCUSED window's active tab cannot steal the focused page's dwell (Fix 4)", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Focused window (id 1): a clearly off-goal page; set-goal schedules its 5s dwell.
    activeTab = { id: 7, url: "https://video.test/watch?v=fox", title: "귀여운 여우 영상 몰아보기", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "통계학 회귀분석 과제 풀이", minutes: null })
    await settle(50)

    // A SECOND window's active tab storms title updates during that dwell. Tab.active is
    // per-window, so it reports active:true even though its window (id 2) is NOT focused.
    // Pre-fix each update passed the `tab.active` check and REPLACED the single dwell
    // checkpoint, so the focused page was never judged (and the side page's own judgement was
    // then dropped by the lastFocusedWindow-scoped stillJudging) — the gauge froze in a
    // NEUTRAL hold. Post-fix the isFocusedWindow gate ignores it entirely.
    for (let i = 0; i < 5; i += 1) {
      const sideTab = { id: 9, url: "https://news.test/live", title: `속보 라이브 #${i}`, active: true, windowId: 2 }
      for (const fn of listeners["tabs.onUpdated"]) await fn(9, { title: sideTab.title }, sideTab)
      mock.timers.tick(1000) // churn spread across the focused page's dwell window
      await settle(0)
    }

    // Advance past the dwell and reconcile: the checkpoint must still hold the FOCUSED page.
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200) // real time for the KoEn-E5 WASM embedding

    // The focused off-goal page got its judgement → DRIFT → heartbeats drain S below 100.
    for (let i = 0; i < 5; i += 1) {
      mock.timers.tick(60_000)
      await fireHeartbeat()
      await settle(0)
    }
    const s = (await send({ type: "get-state" })).s as number
    assert.ok(s < 100, `the focused page's judgement landed and S drains (S=${s}) — the side window did not steal the dwell`)
  } finally {
    mock.timers.reset()
  }
})

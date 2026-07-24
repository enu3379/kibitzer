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
let activeTab: { id: number; url: string; title: string; active: boolean } | null = null
const toasts: Array<Record<string, unknown>> = [] // captured injected toast payloads
const notifications: Array<{ id: string; opts: Record<string, unknown> }> = []

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
  idle: { onStateChanged: evt("idle"), setDetectionInterval() {}, queryState: async () => "active" },
  windows: { onFocusChanged: evt("win"), getLastFocused: async () => ({ focused: true }), WINDOW_ID_NONE: -1 },
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
    activeTab = { id: 1, url: "https://video.test/watch?v=cat", title: "귀여운 고양이 영상 몰아보기", active: true }
    const setRes = await send({ type: "set-goal", goal: "파이썬 알고리즘 문제 풀이", minutes: null })
    assert.ok((setRes.goal as { text?: string })?.text, "goal was declared")
    await settle(50) // let the fire-and-forget observeActiveTab schedule the dwell

    // The dwell hasn't elapsed in real time; advance the mocked clock past it and let the
    // wake-time reconcile do the judgement (avoids a real 5s wait).
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200) // real time for the KoEn-E5 WASM embedding to finish

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
    activeTab = { id: 2, url: "https://example.test/neutral", title: "중립 페이지", active: true }
    await send({ type: "set-goal", goal: "분기 보고서 작성", minutes: null })
    await settle(50)

    // Navigate to a SENSITIVE page (a bank). observe() must drop it before any judging.
    activeTab = { id: 2, url: "https://chase.com/account/summary", title: "Account Summary", active: true }
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
    activeTab = { id: 3, url: "https://video.test/watch?v=cat", title: "귀여운 고양이 영상 몰아보기", active: true }
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
    activeTab = { id: 3, url: "https://docs.python.org/3/tutorial/", title: "파이썬 알고리즘 문제 풀이 튜토리얼", active: true }
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

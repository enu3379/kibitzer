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
const createdTabs: string[] = [] // URLs opened via chrome.tabs.create (onboarding assertions)
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
    create: async (opts: { url?: string } = {}) => {
      createdTabs.push(opts.url ?? "")
      return {}
    },
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

// A heartbeat's alarm listener is fire-and-forget (`void getGoal().then(async () => … dispatch)`),
// so `await fireHeartbeat()` returns BEFORE the work it triggers finishes: dispatch → outbox drain
// → showToast → executeScript all run async afterwards. When a beat is expected to DELIVER something
// (the S=0 nag), reading `toasts` after a single `settle(0)` races that delivery on a loaded runner —
// the nag lands one macrotask after the check, so `nagged` reads false (the original flake). Pass
// `until` there to poll REAL time until the delivery lands (early-out the moment it does).
//
// With NO `until`, keep the beat as short as possible: a drain/hold/absence beat has nothing to wait
// for, and burning real time here would let real timers a test relies on NOT firing elapse — e.g. an
// unjudged page's 5s dwell would fire mid-hold and recover S, breaking the freeze test. Only Date is
// mocked, so `settle` is a real timer; a bare `settle(0)` yields one macrotask, matching the old fast
// beats those loops were proven against.
const BEAT_SETTLE_STEPS = 60 // ~120ms real-time cap for a delivery wait — ample under CI load
async function beat(until?: () => boolean): Promise<void> {
  mock.timers.tick(60_000)
  await fireHeartbeat()
  if (!until) return void (await settle(0)) // fast beat: nothing to await, don't elapse real timers
  for (let i = 0; i < BEAT_SETTLE_STEPS; i += 1) {
    await settle(2)
    if (until()) return
  }
}
const nagDelivered = (): boolean => toasts.some((t) => t.kind === "intervention") || notifications.length > 0

test("E2E: goal → drift on an off-goal page → S drains to 0 → nag delivered", async () => {
  // PHASE 1 — REAL time. Let the real (threaded) WASM pipeline judge the off-goal page DRIFT with
  // NO mocked timers in play, so no fake clock is advanced while an embed is in flight. The verdict
  // is deterministic (title vs goal cosine ≈ 0.22, well under τ=0.59), and this keeps the two clocks
  // from overlapping during judging — separating the concern from the drain phase below.
  activeTab = { id: 1, url: "https://video.test/watch?v=cat", title: "귀여운 고양이 영상 몰아보기", active: true, windowId: 1 }
  const setRes = await send({ type: "set-goal", goal: "파이썬 알고리즘 문제 풀이", minutes: null })
  assert.ok((setRes.goal as { text?: string })?.text, "goal was declared")

  // The dwell is a real 5s timer; wait (real time) for it plus the embed to land the DRIFT verdict.
  // reconcile is single-flight, so polling fireStartup can't double-judge.
  let judged = false
  for (let i = 0; i < 200 && !judged; i += 1) {
    await settle(100)
    await fireStartup() // reconcile judges once the real dwell deadline has actually passed
    judged = /final=DRIFT/.test((await send({ type: "get-log" })).text as string)
  }
  assert.ok(judged, "the off-goal page was judged DRIFT in real time")
  await settle(200) // let the nav dispatch + any threaded-WASM callbacks fully settle

  // PHASE 2 — MOCKED time. No real async is pending now, and heartbeats never re-judge, so the
  // active verdict stays DRIFT and S drains monotonically (proved in core/gauge/sZeroNag.test.ts).
  // The drain is therefore deterministic: S reaches 0 and the degraded S=0 gate nags exactly once —
  // a celebration is impossible without a verdict flip, which nothing here produces.
  mock.timers.enable({ apis: ["Date"], now: Date.now() }) // start the fake clock at "now" (>= updatedAt)
  try {
    const mid = await send({ type: "get-state" })
    assert.equal((mid.goal as { text?: string })?.text, "파이썬 알고리즘 문제 풀이")
    assert.ok(typeof mid.s === "number" && (mid.s as number) <= 100, `S present: ${mid.s}`)

    // Drive heartbeats (synthetic 1-min steps) until the gauge bottoms out and the nag lands.
    // beat() waits for the fire-and-forget delivery, so `nagged` can't be read before the toast does.
    let nagged = false
    for (let i = 0; i < 200 && !nagged; i += 1) {
      await beat(nagDelivered)
      nagged = nagDelivered()
    }

    const final = await send({ type: "get-state" })
    assert.ok(nagged, `a nag was delivered once S drained (final S=${final.s}, toasts=${toasts.length})`)
    assert.equal(final.s, 0, "S bottomed out at 0")
    // The lifetime-first intervention toast carries the one-time explainer variant.
    assert.equal(
      (toasts[0] as { firstRun?: boolean } | undefined)?.firstRun,
      true,
      "the first-ever intervention toast is the explainer variant",
    )
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
    // The sensitive page is dropped before any dwell/judge, so no verdict, drain, or nag is ever
    // queued — the absence below is structural. Fast beats (no delivery to await) suffice.
    for (let i = 0; i < 10; i += 1) await beat()

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
      // Fast beats (no delivery to await, and the real dwell below must not elapse). A one-beat lag
      // in the read just costs an extra iteration — the loop stops the first time S is seen ≤ 50.
      await beat()
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
    for (let i = 0; i < 15; i += 1) await beat()
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
    // The first-run explainer slot was consumed by the suite's first nag (the drain
    // scenario above) — every later toast must render the normal compact variant.
    for (const t of toasts) {
      assert.ok(!(t as { firstRun?: boolean }).firstRun, "later nags render the normal toast")
    }
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

test("E2E: first install opens the onboarding tab once — updates and re-fires never re-open it", async () => {
  createdTabs.length = 0
  const fireInstalled = async (details?: { reason: string }) => {
    for (const fn of listeners["runtime.onInstalled"]) await fn(details)
    await settle(20) // the listener's storage check + tabs.create are async
  }
  const opened = () => createdTabs.filter((u) => u.includes("onboarding/onboarding.html")).length

  await fireInstalled({ reason: "install" })
  assert.equal(opened(), 1, "a true first install opens the wizard tab")

  await fireInstalled({ reason: "install" }) // duplicate install event → storage flag blocks it
  await fireInstalled({ reason: "update" }) // extension update (incl. unpacked reloads)
  await fireInstalled() // defensive: event fired with no details
  assert.equal(opened(), 1, "the wizard never opens a second time")
})

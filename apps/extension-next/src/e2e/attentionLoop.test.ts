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
import { kvDelete, kvGet } from "../lib/db.ts"
import { PENDING_DWELL_KEY } from "../lib/dwellScheduler.ts"
import { LOCAL_PDF_PROMPT_DELAY_MS, LOCAL_PDF_PROMPT_SHOWN_KEY } from "../lib/localPdfPrompt.ts"
import type { PendingDwell } from "../lib/dwell.ts"

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
type MockTab = { id: number; url: string; title: string; active: boolean; windowId: number }
let activeTab: MockTab | null = null
let tabQuerySequence: Array<MockTab | null> = []
const createdWindows: Array<Record<string, unknown>> = []
const updatedTabs: Array<{ tabId: number; props: Record<string, unknown> }> = []
let promptWindowOpen = false
let windowFocusFails = false
let navigateOnActivateUrl: string | null = null
const toasts: Array<Record<string, unknown>> = [] // captured injected toast payloads
const notifications: Array<{ id: string; opts: Record<string, unknown> }> = []
let executeScriptCalls = 0
let settingsReadGate: { reached: () => void; release: Promise<void> } | null = null
// Presence knobs (browserPresent = Chrome focused AND idle-active). Default present, so the
// existing scenarios are unaffected; the presence-gate scenario flips these and restores them.
let winFocused = true
let idleActive = true

const chrome = {
  tabs: {
    onUpdated: evt("tabs.onUpdated"),
    onActivated: evt("tabs.onActivated"),
    query: async (query: Record<string, unknown> = {}) => {
      const tab = tabQuerySequence.length > 0 ? tabQuerySequence.shift() : activeTab
      if (query.windowId != null && tab?.windowId !== query.windowId) return []
      return tab ? [tab] : []
    },
    get: async (tabId: number) => activeTab?.id === tabId ? activeTab : undefined,
    update: async (tabId: number, props: Record<string, unknown>) => {
      updatedTabs.push({ tabId, props })
      if (navigateOnActivateUrl && activeTab?.id === tabId) {
        activeTab.url = navigateOnActivateUrl
        navigateOnActivateUrl = null
      }
      return activeTab
    },
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
  windows: {
    onFocusChanged: evt("win"),
    getLastFocused: async () => ({ focused: winFocused, id: 1 }),
    get: async () => ({ id: 1, left: 100, top: 40, width: 1400, height: 900 }),
    getAll: async () => promptWindowOpen
      ? [{
          id: 9,
          type: "popup",
          // Immediately after windows.create resolves the target can exist only as pendingUrl.
          tabs: [{ id: 99, pendingUrl: `${pathToFileURL(assetDisk("localPdfPrompt/localPdfPrompt.html")).href}?tabId=12` }],
        }]
      : [],
    create: async (opts: Record<string, unknown>) => {
      createdWindows.push(opts)
      promptWindowOpen = true
      return { id: 9 }
    },
    update: async () => {
      if (windowFocusFails) throw new Error("focus refused")
      return { id: 1, focused: true }
    },
    WINDOW_ID_NONE: -1,
  },
  notifications: {
    onButtonClicked: evt("nb"),
    onClicked: evt("nc"),
    create: (id: string, opts: Record<string, unknown>) => notifications.push({ id, opts }),
    clear: async () => {},
  },
  scripting: {
    executeScript: async ({ args }: { args?: unknown[] }) => {
      executeScriptCalls += 1
      const payload = args?.[0]
      if (payload && typeof payload === "object" && "message" in payload) toasts.push(payload as Record<string, unknown>)
      return [{ result: undefined }]
    },
  },
  storage: {
    local: {
      get: async (key: string) => {
        const snapshot = store.has(key) ? { [key]: store.get(key) } : {}
        if (key === "kibitzer:settings:v1" && settingsReadGate) {
          const gate = settingsReadGate
          settingsReadGate = null
          gate.reached()
          await gate.release
        }
        return snapshot
      },
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
const { extractActiveExcerpt, setActivePage, testNag } = await import("../lib/gaugeRuntime.ts")
const { getGoal } = await import("../lib/session.ts")

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
const settleUntil = async (until: () => boolean, steps = 100): Promise<boolean> => {
  for (let i = 0; i < steps; i += 1) {
    if (until()) return true
    await settle(5)
  }
  return until()
}

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

test("E2E: local PDFs are opt-in and their dwell checkpoint never stores the file path", async () => {
  const rawUrl = "file:///C:/Users/alice/Private/secret-paper.pdf"
  activeTab = { id: 12, url: rawUrl, title: "secret-paper.pdf", active: true, windowId: 1 }
  await send({ type: "set-settings", settings: { observeLocalPdfs: false } })
  await send({ type: "set-goal", goal: "논문 읽기", minutes: null })
  await settle(Math.floor(LOCAL_PDF_PROMPT_DELAY_MS / 2))
  assert.equal(createdWindows.length, 0, "the prompt waits for the PDF viewer to appear")
  assert.ok(
    await settleUntil(
      () => createdWindows.length === 1,
      Math.ceil((LOCAL_PDF_PROMPT_DELAY_MS + 1000) / 5),
    ),
    "the first OFF local PDF opens one opt-in popup",
  )

  assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "OFF local PDF never creates a dwell")
  assert.equal((await send({ type: "get-state" })).s, 100, "OFF local PDF holds the gauge neutral")
  assert.equal(createdWindows.length, 1)
  assert.equal(createdWindows[0]?.type, "popup")
  assert.equal(createdWindows[0]?.left, 1102)
  assert.equal(createdWindows[0]?.top, 642)
  assert.ok(String(createdWindows[0]?.url).includes("localPdfPrompt.html?tabId=12"))
  assert.ok(
    !JSON.stringify(createdWindows[0]).includes("alice") && !JSON.stringify(createdWindows[0]).includes("secret-paper"),
    "prompt URL carries no source local path",
  )

  for (const fn of listeners["tabs.onUpdated"]) await fn(12, { title: activeTab.title }, activeTab)
  await settle(30)
  assert.equal(createdWindows.length, 1, "title storms never duplicate the one-time popup")

  store.delete(LOCAL_PDF_PROMPT_SHOWN_KEY)
  for (const fn of listeners["tabs.onUpdated"]) await fn(12, { title: activeTab.title }, activeTab)
  assert.ok(
    await settleUntil(() => store.has(LOCAL_PDF_PROMPT_SHOWN_KEY)),
    "restart recovery repairs the missing shown marker",
  )
  assert.equal(createdWindows.length, 1, "restart recovery recognizes an already-created prompt")
  assert.ok(store.has(LOCAL_PDF_PROMPT_SHOWN_KEY))

  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: true, settingEnabled: true },
  )
  await settle(30)
  assert.ok(updatedTabs.some((entry) => entry.tabId === 12 && entry.props.active === true))
  const initial = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
  assert.ok(initial)

  await settle(10)
  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: true, settingEnabled: true },
    "an already-ON race still focuses and starts a fresh dwell",
  )
  const refreshed = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
  assert.ok(refreshed && refreshed.dueAt > initial.dueAt, "the already-ON retry never inherits the old deadline")

  windowFocusFails = true
  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: false, settingEnabled: true },
    "focus refusal is reported as partial failure, not success",
  )
  windowFocusFails = false

  navigateOnActivateUrl = "https://example.com/not-the-pdf"
  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: false, settingEnabled: true },
    "navigation during activation cannot observe the stale PDF snapshot",
  )
  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: false, settingEnabled: true },
    "an already-navigated source still reports the actual enabled setting",
  )
  activeTab.url = rawUrl
  assert.deepEqual(
    await send({ type: "enable-local-pdf-observation", sourceTabId: 12 }),
    { ok: true, settingEnabled: true },
  )
  const first = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
  assert.ok(first)
  assert.equal(first.kind, "local_pdf")
  assert.equal(first.urlHost, "local-pdf")
  assert.equal(first.title, "secret-paper.pdf", "Chrome's filename title is used when PDF metadata has no title")
  assert.equal((first as PendingDwell & { url?: string }).url, undefined)
  assert.ok(!JSON.stringify(first).includes("alice") && !JSON.stringify(first).includes("file:///"))
  const beforeExcerpt = executeScriptCalls
  assert.equal(await extractActiveExcerpt(first.pageKey), null)
  assert.equal(executeScriptCalls, beforeExcerpt, "PDF excerpt policy returns before executeScript")

  activeTab.title = "PDF metadata title"
  for (const fn of listeners["tabs.onUpdated"]) await fn(12, { title: activeTab.title }, activeTab)
  await settle(30)
  const updated = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
  assert.equal(updated?.dueAt, first.dueAt, "same PDF title update keeps the original dwell deadline")
  assert.equal(updated?.title, "PDF metadata title", "the latest Chrome tab title wins")

  await send({ type: "set-settings", settings: { observeLocalPdfs: false } })
  await settle(30)
  assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "OFF cancels a pending PDF dwell")

  // Race: an ON observation snapshots its setting, OFF cancels, then the stale invocation
  // resumes. It must not recreate a durable checkpoint after the OFF transition.
  await send({ type: "set-settings", settings: { observeLocalPdfs: true } })
  await settle(30)
  let reached!: () => void
  let release!: () => void
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve))
  const releasePromise = new Promise<void>((resolve) => (release = resolve))
  settingsReadGate = { reached, release: releasePromise }
  activeTab.title = "stale observation"
  for (const fn of listeners["tabs.onUpdated"]) fn(12, { title: activeTab.title }, activeTab)
  await reachedPromise
  await send({ type: "set-settings", settings: { observeLocalPdfs: false } })
  release()
  await settle(50)
  assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "stale ON observe cannot rewrite after OFF")

  // Chrome's built-in PDF viewer is not a reliable surface for an injected overlay. A local
  // PDF nudge must use the OS-notification fallback, while persona templates see the allowed
  // Chrome tab title instead of the opaque `local-pdf` identity.
  const enabledSettings = await send({ type: "set-settings", settings: { observeLocalPdfs: true } })
  activeTab.title = "PDF metadata title"
  await setActivePage({
    pageKey: first.pageKey,
    title: activeTab.title,
    urlHost: "local-pdf",
    score: 0.2,
    kind: "local_pdf",
    localPdfPolicyRevision: enabledSettings.localPdfPolicyRevision as number,
  })
  toasts.length = 0
  notifications.length = 0
  await send({ type: "set-persona", persona: "yandere" })
  tabQuerySequence = [
    { id: 12, url: "https://example.test/before-pdf", title: "Previous web page", active: true, windowId: 1 },
    { id: 12, url: "https://example.test/during-delivery", title: "Interim web page", active: true, windowId: 1 },
    activeTab,
  ]
  const random = mock.method(Math, "random", () => 0)
  try {
    await testNag(await getGoal())
  } finally {
    random.mock.restore()
  }
  assert.equal(toasts.length, 0, "local PDFs never pretend an injected overlay was visible")
  assert.equal(notifications.length, 1, "local PDF nags use the OS notification fallback")
  const notificationMessage = String(notifications[0]?.opts.message ?? "")
  assert.ok(notificationMessage.includes("PDF metadata title"), "the nudge uses the Chrome tab title")
  assert.ok(!notificationMessage.includes("local-pdf"), "the opaque identity is never user-facing copy")
  // The one-time explainer variant only renders inside an injected toast, so a delivery that
  // routes to the OS notification must leave the lifetime slot unspent — otherwise a user
  // whose first-ever nag lands on a PDF loses the explainer without ever seeing it.
  assert.equal(
    await kvGet("first-nag-count"),
    undefined,
    "the OS-notification fallback must not consume the one-time explainer slot",
  )
  await kvDelete("first-nag-count") // keep the suite's lifetime-first toast scenario isolated
  notifications.length = 0
  toasts.length = 0
  await send({ type: "set-persona", persona: "dry_kibitzer" })

  await send({ type: "set-goal", goal: "", minutes: null })
  activeTab = { id: 1, url: "https://example.test/neutral", title: "중립 페이지", active: true, windowId: 1 }
})
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
    // The exportable debug log must never NAME the sensitive page: neither the drop line nor
    // the gauge trace (which echoes the neutral hold's activePageKey) may carry its host.
    const log = (await send({ type: "get-log" })).text as string
    assert.ok(!log.includes("chase.com"), "the sensitive host never appears in the exportable log")
    assert.ok(/drop \(sensitive\)/.test(log), "the drop itself is still traced (category only)")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: '관련 있어요' clicked while a sensitive page is active — no recovery, never named", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Fresh session on a neutral page (a distinct goal → resetState wipes the prior scenario).
    // Distinct URL/title/id from the user-lists scenario below, so the obsKey dedup this test
    // leaves behind can never swallow that scenario's first observation.
    activeTab = { id: 8, url: "https://example.test/tax-prep", title: "세금 준비 자료", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "세금 신고 준비", minutes: null })
    await settle(50)

    // A nag notification can outlive the page it nagged about: the user switches to a BANK tab,
    // then clicks "목표와 관련 있어요" on the stale nag. The handler re-queries the active tab, so
    // without a guard the bank would be klogged, dispatched into the gauge, and stored in visits.
    activeTab = { id: 8, url: "https://chase.com/account/summary", title: "Account Summary", active: true, windowId: 1 }
    await send({ type: "kibitzer:toast-feedback", kind: "related" })
    await settle(100)

    const log = (await send({ type: "get-log" })).text as string
    assert.ok(!log.includes("chase.com"), "the sensitive host never appears in the exportable log")
    assert.ok(!/related → OK recover/.test(log), "the OK-recovery is skipped entirely on a sensitive page")
    const events = JSON.stringify(await send({ type: "export-events" }))
    assert.ok(!events.includes("chase.com"), "the sensitive host never appears in the durable event export")
  } finally {
    mock.timers.reset()
  }
})

test("E2E: user domain lists — a blocked host drops host-free, an allowlisted host judges OK without Tier-0", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    await send({ type: "clear-log" })
    // Fresh session on a neutral page; register both user lists via the options message path.
    activeTab = { id: 4, url: "https://example.test/neutral", title: "중립 페이지", active: true, windowId: 1 }
    await send({ type: "set-goal", goal: "논문 초록 정리", minutes: null })
    const setRes = (await send({
      type: "set-domain-lists",
      lists: { block: ["blocked.test"], allow: ["allowed.test"] },
    })) as { lists?: { block: string[]; allow: string[] }; rejected?: string[] }
    assert.deepEqual(setRes.lists, { block: ["blocked.test"], allow: ["allowed.test"] })
    assert.deepEqual(setRes.rejected, [])
    await settle(50)

    // Navigate to the USER-blocked page: dropped like a sensitive page — no dwell checkpoint,
    // no judging, gauge held NEUTRAL.
    activeTab = { id: 4, url: "https://blocked.test/very/private/path", title: "비밀 페이지", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onUpdated"]) await fn(4, { status: "complete" }, activeTab)
    await settle(50)
    mock.timers.tick(6000)
    await fireStartup() // reconcile: there is no checkpoint to judge
    await settle(300)
    for (let i = 0; i < 10; i += 1) await beat()
    let log = (await send({ type: "get-log" })).text as string
    assert.ok(log.includes("drop (user-blocked)"), "the drop is logged as a fixed string")
    assert.ok(!log.includes("blocked.test"), "the blocked host never appears in the log")
    let st = await send({ type: "get-state" })
    assert.equal(st.s, 100, "a user-blocked page holds the gauge — S must not drain")

    // Navigate to the ALLOWLISTED page: judged OK without any Tier-0 embed once the dwell
    // elapses — recorded as a normal observation, no nag, S stays full (OK recovers).
    activeTab = { id: 4, url: "https://allowed.test/docs/ch1", title: "완전 다른 주제의 문서", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onUpdated"]) await fn(4, { status: "complete" }, activeTab)
    await settle(50)
    mock.timers.tick(6000)
    await fireStartup() // reconcile fires the dwell's judgement (no WASM needed on this path)
    await settle(300)
    log = (await send({ type: "get-log" })).text as string
    assert.ok(/user-allow final=OK/.test(log), "the allowlisted page short-circuited to OK")
    assert.ok(!/final=DRIFT/.test(log), "no Tier-0 judgement ran for the allowlisted page")
    for (let i = 0; i < 10; i += 1) await beat()
    st = await send({ type: "get-state" })
    assert.equal(st.s, 100, "an always-OK page keeps S full")
    assert.equal(toasts.length + notifications.length, 0, "no nag on either list")

    // Clean up the lists so later scenarios observe an unfiltered world.
    await send({ type: "set-domain-lists", lists: { block: [], allow: [] } })
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

test("E2E: bouncing back to a judged page within another page's dwell re-enters the pipeline — no indefinite freeze", async () => {
  mock.timers.enable({ apis: ["Date"] })
  try {
    toasts.length = 0
    notifications.length = 0
    // Fresh session on a clearly off-goal page; set-goal schedules its 5s dwell.
    const pageX = { id: 13, url: "https://video.test/watch?v=owl", title: "귀여운 올빼미 영상 몰아보기", active: true, windowId: 1 }
    activeTab = pageX
    await send({ type: "set-goal", goal: "선형대수 고유값 증명 공부", minutes: null })
    await settle(50)

    // Judge X → DRIFT (advance past the dwell, reconcile does the judge).
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200) // real time for the KoEn-E5 WASM embedding

    // Prove integration is live (S drains under X's DRIFT), then remember where S sits.
    let sMid = 100
    for (let i = 0; i < 30 && sMid >= 100; i += 1) {
      await beat()
      sMid = (await send({ type: "get-state" })).s as number
    }
    assert.ok(sMid < 100, `X was judged DRIFT and S is draining (S=${sMid})`)

    // Tab-switch to an unjudged page Y: NEUTRAL hold, Y's dwell armed.
    activeTab = { id: 14, url: "https://blog.test/daily-essay", title: "일상 잡담 에세이", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onActivated"]) await fn({ tabId: 14, windowId: 1 })
    await settle(50)

    // Bounce BACK to X within Y's dwell. lastObservedKey still names X (only judgeAndDispatch
    // writes it), so pre-fix observe(X) early-returned on the bare key match: nothing was
    // re-armed, Y's dwell later fired against the wrong active tab and was dropped, and the
    // gauge froze on Y with a null verdict — no drain, no recovery, no drift detection.
    activeTab = pageX
    for (const fn of listeners["tabs.onActivated"]) await fn({ tabId: 13, windowId: 1 })
    await settle(50)
    const rearmed = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
    assert.equal(rearmed?.title, pageX.title, "the bounce-back re-armed the dwell for X, not Y")

    // X re-judges after its dwell → DRIFT again → S RESUMES draining below sMid.
    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200)
    let sResumed = sMid
    for (let i = 0; i < 30 && sResumed >= sMid; i += 1) {
      await beat()
      sResumed = (await send({ type: "get-state" })).s as number
    }
    assert.ok(sResumed < sMid, `the gauge resumed integrating after the bounce (S ${sMid} → ${sResumed})`)

    // The storm guard survives the fix: an identical onUpdated for the judged, ACCOUNTED page
    // is still debounced — no new dwell is armed (the checkpoint was consumed by the judge).
    for (const fn of listeners["tabs.onUpdated"]) await fn(13, { title: pageX.title }, pageX)
    await settle(50)
    assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "identical-page churn on an accounted page schedules nothing")

    // Variant: the return goes THROUGH another app. Switch to unjudged Z, lose focus entirely
    // (WINDOW_ID_NONE cancels Z's dwell — the judge that would reset lastObservedKey never
    // runs), then regain focus on X. Pre-fix the stale key froze the gauge with NOTHING
    // pending to ever recover it.
    activeTab = { id: 15, url: "https://blog.test/second-essay", title: "두 번째 잡담 에세이", active: true, windowId: 1 }
    for (const fn of listeners["tabs.onActivated"]) await fn({ tabId: 15, windowId: 1 })
    await settle(50)
    for (const fn of listeners["win"]) await fn(chrome.windows.WINDOW_ID_NONE)
    await settle(50)
    assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "focus loss cancelled Z's dwell")
    activeTab = pageX
    for (const fn of listeners["win"]) await fn(1)
    await settle(50)
    const reobserved = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
    assert.equal(reobserved?.title, pageX.title, "focus regain re-armed X's dwell despite the stale debounce key")

    mock.timers.tick(6000)
    await fireStartup()
    await settle(1200)
    let sFinal = sResumed
    for (let i = 0; i < 30 && sFinal >= sResumed; i += 1) {
      await beat()
      sFinal = (await send({ type: "get-state" })).s as number
    }
    assert.ok(sFinal < sResumed, `the gauge resumed after the through-another-app bounce (S ${sResumed} → ${sFinal})`)
  } finally {
    mock.timers.reset()
  }
})

test("E2E: a pending dwell never survives returning to a held internal page or disabled PDF", async () => {
  // The internal-page and disabled-PDF branches debounce on lastObservedKey too. Pre-fix their
  // early return sat ABOVE dwell.cancel(), so held-page → real page Y → back within Y's dwell
  // left Y's checkpoint alive; it then fired against the held page, was dropped, and the gauge
  // froze on Y with nothing armed. The cancel must run even on the debounced path.
  const newtab = { id: 16, url: "chrome://newtab/", title: "New Tab", active: true, windowId: 1 }
  activeTab = newtab
  await send({ type: "set-goal", goal: "재무 보고서 검토", minutes: null })
  await settle(50) // set-goal observes the newtab → internal hold, lastObservedKey = internal key

  // Open a real page in that tab: its dwell is armed.
  activeTab = { id: 16, url: "https://blog.test/third-essay", title: "세 번째 잡담 에세이", active: true, windowId: 1 }
  for (const fn of listeners["tabs.onUpdated"]) await fn(16, { status: "complete" }, activeTab)
  await settle(50)
  assert.ok(await kvGet<PendingDwell>(PENDING_DWELL_KEY), "the real page armed a dwell")

  // Back to the identical newtab within the dwell — the debounced internal path must still cancel.
  activeTab = newtab
  for (const fn of listeners["tabs.onUpdated"]) await fn(16, { status: "complete" }, activeTab)
  await settle(50)
  assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "returning to the held internal page cancels the abandoned dwell")

  // Same shape through holdLocalPdfDisabled: all disabled PDFs share one debounce key.
  await send({ type: "set-settings", settings: { observeLocalPdfs: false } })
  activeTab = { id: 16, url: "file:///C:/docs/one.pdf", title: "one.pdf", active: true, windowId: 1 }
  for (const fn of listeners["tabs.onUpdated"]) await fn(16, { status: "complete" }, activeTab)
  await settle(50) // → lastObservedKey = "local-pdf#disabled"

  activeTab = { id: 16, url: "https://blog.test/fourth-essay", title: "네 번째 잡담 에세이", active: true, windowId: 1 }
  for (const fn of listeners["tabs.onUpdated"]) await fn(16, { status: "complete" }, activeTab)
  await settle(50)
  assert.ok(await kvGet<PendingDwell>(PENDING_DWELL_KEY), "the real page armed a dwell (PDF phase)")

  activeTab = { id: 16, url: "file:///C:/docs/two.pdf", title: "two.pdf", active: true, windowId: 1 }
  for (const fn of listeners["tabs.onUpdated"]) await fn(16, { status: "complete" }, activeTab)
  await settle(50)
  assert.equal(await kvGet(PENDING_DWELL_KEY), undefined, "a second disabled PDF (same debounce key) still cancels the abandoned dwell")

  // Clear the goal BEFORE re-enabling PDFs: the ON edge reobserves the active tab, and with a
  // live goal that would arm a real 5s dwell that outlives this test (a trap for later tests).
  await send({ type: "set-goal", goal: "", minutes: null })
  await send({ type: "set-settings", settings: { observeLocalPdfs: true } })
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

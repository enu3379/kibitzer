// Onboarding wizard — opened once by background.ts on first install. Reuses the real
// product pieces instead of forking them: the practice nag calls the actual toast
// renderer, the final step embeds the live popup in an iframe, persona copy comes from
// personas.data.ts, and the immersion band mapping is the popup's own bandOf().

import { showKibitzerToast } from "../content/toastOverlay.ts"
import { playChime } from "../lib/chime.ts"
import { sundialSVG } from "../lib/sundial.ts"
import { bandOf } from "../lib/sessionStats.ts"
import { PERSONAS, PERSONA_DEFAULT } from "../lib/personas.data.ts"
import { DEFAULT_PERSONA_KEYS, fillTemplate } from "../lib/personas.ts"
import { defaultRoute, PROVIDER_PROFILES, profileFor, type ProviderId } from "../lib/providers.ts"

interface WizardState {
  persona?: string
  judgeEnabled?: boolean
}

interface JudgeView {
  routes?: {
    tier1?: { provider?: string; model?: string }
    tier2?: { provider?: string; model?: string }
  }
}

interface RouteTestResult {
  ok: boolean
  detail: string
}

interface CandidateKeyCommitResult {
  ok: boolean
  tiers: { tier1: RouteTestResult; tier2: RouteTestResult }
  view: JudgeView | null
  /** Set instead of `tiers` when the service worker itself failed to run the test. */
  error?: string
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// The wizard also renders standalone (e.g. opening the dist file directly); every
// extension-API touch goes through these guards so the page degrades instead of dying.
const extension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)
const send = async <T>(msg: unknown): Promise<T | null> => {
  if (!extension) return null
  try {
    return (await chrome.runtime.sendMessage(msg)) as T
  } catch {
    return null
  }
}

// --- step navigation ---------------------------------------------------------------

const steps = [...document.querySelectorAll<HTMLElement>(".step")]
const dots = $("dots")
const count = $("count")
const prev = $<HTMLButtonElement>("prev")
const next = $<HTMLButtonElement>("next")
const nav = $("nav")
let cur = 0

// Step indices (see onboarding.html section order); the done screen is index 6.
const STEP_PIN = 3
const STEP_AI = 4
const STEP_PERSONA = 5

for (let i = 0; i < 6; i++) {
  const d = document.createElement("button")
  d.setAttribute("aria-label", `${i + 1}단계`)
  d.addEventListener("click", () => go(i))
  dots.appendChild(d)
}

function go(i: number): void {
  cur = Math.max(0, Math.min(steps.length - 1, i))
  steps.forEach((s, j) => (s.hidden = j !== cur))
  ;[...dots.children].forEach((d, j) =>
    j === cur ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current"),
  )
  count.textContent = cur < 6 ? `${cur + 1} / 6` : "완료"
  prev.style.visibility = cur === 0 ? "hidden" : "visible"
  nav.style.display = cur === 6 ? "none" : "flex"
  next.textContent = cur === STEP_PERSONA ? "마무리 →" : "다음 →"
  if (cur === STEP_AI) void refreshAiStatus()
  if (cur === STEP_PIN || cur === STEP_PERSONA) void refreshPin()
  syncPinUi(false)
}
prev.addEventListener("click", () => go(cur - 1))
next.addEventListener("click", () => go(cur + 1))

// --- persona copy (real fallback templates, demo context) --------------------------
// fillTemplate is the shared particle-aware fill: "{goal}이" + "논문 정리" → "논문 정리가".

let currentPersona = PERSONA_DEFAULT

const DEMO_GOAL = "졸업논문 초안 쓰기"
const demoNagMessage = (): string =>
  fillTemplate(PERSONAS[currentPersona]?.fallbackTemplates[0] ?? "", {
    goal: DEMO_GOAL,
    host: "youtube.com",
    title: "곱창 먹방 4시간 풀코스",
    nag_count: "4",
  })

function firePracticeToast(message: string, contextLabel: string): void {
  void playChime("intervention")
  showKibitzerToast({
    notificationId: "onboarding-demo",
    displayToken: -1,
    message,
    contextLabel,
    autoDismissMs: 12_000,
    kind: "intervention",
    demo: true,
  })
}

// --- step 2: gauge demo driving the real agauge component --------------------------

const BAND_WORD = { ok: "집중", warn: "흔들림", bad: "이탈" } as const
const BAND_CLS = { ok: "agauge", warn: "agauge warn", bad: "agauge bad" } as const

const DEMO_SEQ = [
  { site: "scholar.google.com — attention guard 관련 논문", tag: "몰입", cls: "in", s: 86 },
  { site: "velog.io — MV3 서비스워커 삽질기", tag: "애매", cls: "gray", s: 78 },
  { site: "youtube.com — 곱창 먹방 4시간 풀코스", tag: "이탈", cls: "out", s: 47 },
  { site: "youtube.com — 알고리즘이 권한 또 먹방", tag: "이탈", cls: "out", s: 16 },
]

const demoGauge = $("demoGauge")
const demoFill = $("demoFill")
const demoWord = $("demoWord")
const demoScore = $("demoScore")
const visits = $("visits")
const play = $<HTMLButtonElement>("play")
let demoTimers: number[] = []

function setDemoGauge(s: number): void {
  const band = bandOf(s)
  demoGauge.className = BAND_CLS[band]
  demoFill.style.width = `${s}%`
  demoWord.innerHTML = `<span class="dot">●</span>${BAND_WORD[band]}`
  demoScore.textContent = String(s)
}

play.addEventListener("click", () => {
  demoTimers.forEach(clearTimeout)
  demoTimers = []
  visits.innerHTML = ""
  setDemoGauge(78)
  play.disabled = true
  DEMO_SEQ.forEach((v, i) => {
    demoTimers.push(
      window.setTimeout(() => {
        const el = document.createElement("div")
        el.className = "visit"
        const site = document.createElement("span")
        site.className = "site"
        site.textContent = v.site
        const tag = document.createElement("span")
        tag.className = `vtag ${v.cls}`
        tag.textContent = v.tag
        el.append(site, tag)
        visits.appendChild(el)
        setDemoGauge(v.s)
      }, 700 * (i + 1)),
    )
  })
  demoTimers.push(
    window.setTimeout(() => {
      firePracticeToast(demoNagMessage(), "게이지가 바닥났습니다 — 실제로도 보던 페이지 위에 이렇게 뜹니다")
      play.disabled = false
      play.textContent = "↺ 다시 재생"
    }, 700 * DEMO_SEQ.length + 650),
  )
})

// --- step 3: screen map ------------------------------------------------------------

$("illustSundial").innerHTML = sundialSVG(0.55)
$("miniToastMsg").textContent = demoNagMessage()
$("tryToast").addEventListener("click", () =>
  firePracticeToast("연습 훈수입니다. 진짜 훈수도 정확히 이 자리에, 이렇게 옵니다.", "답하거나, 닫거나, 그냥 두면 사라집니다"),
)

// --- step 4: toolbar pin — persuade, detect, quietly celebrate ---------------------

// Chrome offers no API to pin programmatically; all we can do is show the two clicks
// and watch for them. getUserSettings/onUserSettingsChanged landed after our
// @types/chrome pin; feature-detect instead of typing.
type ActionUserSettings = {
  getUserSettings?: () => Promise<{ isOnToolbar?: boolean }>
  onUserSettingsChanged?: { addListener(cb: (change: { isOnToolbar?: boolean }) => void): void }
}
const actionApi = extension ? (chrome.action as unknown as ActionUserSettings) : undefined

const pinFresh = $("pinFresh")
const pinPre = $("pinPre")
const pinLive = $("pinLive")
const pindemo = $("pindemo")
const nudge = $("nudge")
const pinReminder = $("pinReminder")

let pinOn = false
let pinInitial: boolean | null = null // first observed value — true means "arrived already pinned"
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

// Looping two-click demo: puzzle highlight → menu drops → pin fills → icon pops in.
const DEMO_PHASES = ["p0", "p1", "p2", "p3", "p3"] as const
let demoTimer: number | null = null
let demoIdx = 0

function stopPinDemo(freezeDone = false): void {
  if (demoTimer !== null) clearTimeout(demoTimer)
  demoTimer = null
  if (freezeDone) pindemo.className = "pindemo p3"
}

function startPinDemo(): void {
  if (demoTimer !== null) return // already looping
  if (reducedMotion) {
    pindemo.className = "pindemo p2" // static frame: menu open, both callouts visible
    return
  }
  const tick = (): void => {
    pindemo.className = `pindemo ${DEMO_PHASES[demoIdx]}`
    demoIdx = (demoIdx + 1) % DEMO_PHASES.length
    demoTimer = window.setTimeout(tick, demoIdx === 0 ? 1600 : 1100)
  }
  demoIdx = 0
  tick()
}

// `celebrate` is true only on a live unpinned→pinned transition; any later sync
// (step navigation, polling) renders the settled state without replaying the moment.
function syncPinUi(celebrate: boolean): void {
  const pre = pinOn && pinInitial === true // never teach pinning to the already-pinned
  pinFresh.hidden = pre
  pinPre.hidden = !pre
  pinLive.classList.toggle("on", pinOn)
  pinReminder.hidden = pinOn
  nudge.classList.toggle("on", pinOn)
  nudge.hidden = cur !== STEP_PIN || pre || (pinOn && !celebrate) // stays for the fade-out beat
  if (cur === STEP_PIN && !pre) {
    if (pinOn) stopPinDemo(true)
    else startPinDemo()
  } else {
    stopPinDemo()
  }
  if (celebrate && cur === STEP_PIN) {
    next.classList.remove("pulse")
    void next.offsetWidth // restart the animation when it already ran once
    next.classList.add("pulse")
  }
}
next.addEventListener("animationend", () => next.classList.remove("pulse"))

function onPinState(on: boolean): void {
  const first = pinInitial === null
  if (first) pinInitial = on
  if (!first && on === pinOn) return
  const celebrate = !first && on
  pinOn = on
  syncPinUi(celebrate)
}

async function refreshPin(): Promise<void> {
  try {
    const settings = await actionApi?.getUserSettings?.()
    if (settings) onPinState(Boolean(settings.isOnToolbar))
  } catch {
    // API unavailable (old Chrome) — the drawn instructions stay useful without detection.
  }
}

// Chrome 130+ pushes the change the instant the user pins; older Chromes rely on the
// slow tick below plus the focus listener.
try {
  actionApi?.onUserSettingsChanged?.addListener((change) => {
    if (typeof change?.isOnToolbar === "boolean") onPinState(change.isOnToolbar)
    else void refreshPin()
  })
} catch {
  // Event missing — polling covers it.
}

// --- step 5: Ollama Cloud connect (PR #158 provider API, inlined) ------------------

const aiStatus = $("aiStatus")
const aiStatusText = $("aiStatusText")
const keyInput = $<HTMLInputElement>("key")
const testKeys = $<HTMLButtonElement>("testKeys")
const keysResult = $("keysResult")
type AiTestState = "idle" | "testing" | "success" | "failure"
let aiTestState: AiTestState = "idle"
let judgeConfigured = false

// Ollama is the recommended default (free, one-minute key); the rest of the roster
// is offered here too so switching never has to leave onboarding for the options page.
const keyIssueLink = $<HTMLAnchorElement>("keyIssueLink")
const keyIssueHint = $("keyIssueHint")
const keyIssueHintBreak = $<HTMLBRElement>("keyIssueHintBreak")
const switchProvider = $("switchProvider")
const providerChips = $("providerChips")
let selectedProvider: ProviderId = "ollama"

function renderProviderChoice(): void {
  const profile = profileFor(selectedProvider)
  const host = new URL(profile.keysUrl).host
  keyIssueLink.href = profile.keysUrl
  keyIssueLink.textContent =
    selectedProvider === "ollama" ? `${host}에서 무료 API 키 발급` : `${host}에서 API 키 발급`
  // The "free, one minute" line is an Ollama fact — it (and its line break) just
  // disappears for the others, so the switch-link sits right under the issue link.
  keyIssueHint.hidden = selectedProvider !== "ollama"
  keyIssueHintBreak.hidden = selectedProvider !== "ollama"
  keyInput.placeholder = profile.keyHint
  for (const chip of Array.from(providerChips.children)) {
    chip.setAttribute("aria-pressed", String(chip.getAttribute("data-provider") === selectedProvider))
  }
}

function setChipsOpen(open: boolean): void {
  providerChips.hidden = !open
  switchProvider.setAttribute("aria-expanded", String(open))
}

for (const { id, label } of PROVIDER_PROFILES) {
  const chip = document.createElement("button")
  chip.type = "button"
  chip.dataset.provider = id
  chip.textContent = label
  chip.addEventListener("click", () => {
    selectedProvider = id
    // A failure belonged to the previous provider — don't carry it over.
    if (aiTestState === "failure") {
      aiTestState = "idle"
      showKeyTestResult("")
    }
    renderProviderChoice()
    renderAiStatus()
    setChipsOpen(false)
    keyInput.focus()
  })
  providerChips.append(chip)
}
switchProvider.addEventListener("click", () => setChipsOpen(providerChips.hidden))
switchProvider.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    setChipsOpen(providerChips.hidden)
  }
})
renderProviderChoice()

function renderAiStatus(): void {
  const highlighted = judgeConfigured || aiTestState === "testing" || aiTestState === "success"
  // Nothing to report yet — no box at all until a test runs (or a key is already on file).
  aiStatus.hidden = aiTestState === "idle" && !judgeConfigured && !keysResult.textContent
  aiStatus.classList.toggle("on", highlighted)
  aiStatus.classList.toggle("failed", aiTestState === "failure")
  if (aiTestState === "testing") {
    aiStatusText.textContent = "AI 연결 확인 중… 첫 호출은 느릴 수 있어요"
  } else if (aiTestState === "failure") {
    aiStatusText.textContent = "AI 연결 테스트에 실패했습니다. API 키와 모델 설정을 확인하거나 잠시 후 다시 시도해 주세요."
  } else if (aiTestState === "success" || judgeConfigured) {
    aiStatusText.textContent = "AI 연결됨 ✓  페이지 내용까지 읽고 판정합니다"
  } else {
    aiStatusText.textContent = ""
  }
}

function showKeyTestResult(text: string, kind?: "ok" | "err"): void {
  keysResult.textContent = text
  keysResult.className = `ai-test-detail${kind ? ` ${kind}` : ""}`
  keysResult.setAttribute("aria-hidden", String(!text))
  aiStatus.classList.toggle("has-detail", Boolean(text))
}

function withoutTestVerdict(detail: string): string {
  return detail.replace(/\s+\((?:OK|DRIFT)\)(?=\s*(?:·|$))/u, "")
}

// Onboarding has no model picker — the tier defaults are chosen silently — so the tier
// numbers get their job spelled out, and a failure has to name the model it tried.
// (A success `detail` already starts with the model name, so it isn't repeated there.)
const TIER_LABEL = { tier1: "Tier 1 (빠른 판정)", tier2: "Tier 2 (정밀 판정)" } as const

async function refreshAiStatus(): Promise<void> {
  const st = await send<WizardState>({ type: "get-state" })
  if (!st) return
  judgeConfigured = Boolean(st.judgeEnabled)
  renderAiStatus()
}

testKeys.addEventListener("click", async () => {
  if (testKeys.disabled) return
  if (!keyInput.value.trim()) {
    showKeyTestResult("API 키가 비어 있어요. 위 링크에서 발급한 키를 붙여넣어 주세요.", "err")
    renderAiStatus()
    return
  }
  aiTestState = "testing"
  showKeyTestResult("")
  renderAiStatus()
  aiStatus.setAttribute("aria-busy", "true")
  testKeys.disabled = true
  const models = {
    tier1: defaultRoute("tier1", selectedProvider).model,
    tier2: defaultRoute("tier2", selectedProvider).model,
  }
  try {
    const result = await send<CandidateKeyCommitResult>({
      type: "test-and-add-provider-key",
      provider: selectedProvider,
      name: "",
      value: keyInput.value,
      models,
    })
    const r1 = result?.tiers.tier1
    const r2 = result?.tiers.tier2
    // Always report both tiers. Listing only the failures made a Tier-2-only problem read
    // as a total failure, hiding that the key and the fast route are in fact working.
    // A passing `detail` already opens with the model name, so it isn't repeated there.
    const line = (tier: "tier1" | "tier2", r?: RouteTestResult): string => (
      r?.ok
        ? `${TIER_LABEL[tier]} · ${withoutTestVerdict(r.detail)}`
        : `${TIER_LABEL[tier]} · ${models[tier]} — ${r?.detail ?? "응답 없음"}`
    )
    const report = `${line("tier1", r1)}\n${line("tier2", r2)}`
    if (result?.ok && result.view && r1?.ok && r2?.ok) {
      aiTestState = "success"
      showKeyTestResult(report, "ok")
      keyInput.value = ""
      await refreshAiStatus()
    } else {
      aiTestState = "failure"
      showKeyTestResult(result?.error ?? report, "err")
    }
    renderAiStatus()
  } catch {
    aiTestState = "failure"
    showKeyTestResult("실패 — 응답을 받지 못했습니다.", "err")
    renderAiStatus()
  } finally {
    testKeys.disabled = false
    aiStatus.removeAttribute("aria-busy")
  }
})

const skip = $("skip")
skip.addEventListener("click", () => go(STEP_PERSONA))
skip.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") go(STEP_PERSONA)
})

// --- step 6: persona picker --------------------------------------------------------

const pgrid = $("pgrid")
const sample = $("sample")

const SAMPLE_CTX = {
  goal: "논문 정리",
  host: "youtube.com",
  title: "곱창 먹방 4시간 풀코스",
  nag_count: "3",
  return_minutes: "12",
}

function renderSample(key: string): void {
  const template = PERSONAS[key]?.fallbackTemplates[0] ?? ""
  sample.textContent = `“${fillTemplate(template, SAMPLE_CTX)}”`
}

// First-run shows only the default tier (D15) — lab voices live in 설정 → 말투.
function renderPersonas(): void {
  pgrid.innerHTML = ""
  for (const key of DEFAULT_PERSONA_KEYS) {
    const persona = PERSONAS[key]
    if (!persona) continue
    const b = document.createElement("button")
    b.className = "pcard"
    b.setAttribute("aria-pressed", String(key === currentPersona))
    const name = document.createElement("span")
    name.className = "pn"
    name.textContent = persona.name
    b.appendChild(name)
    b.addEventListener("click", () => {
      currentPersona = key
      void send({ type: "set-persona", persona: key })
      pgrid.querySelectorAll<HTMLElement>(".pcard").forEach((c) =>
        c.setAttribute("aria-pressed", String(c === b)),
      )
      renderSample(key)
      $("miniToastMsg").textContent = demoNagMessage()
    })
    pgrid.appendChild(b)
  }
  renderSample(currentPersona)
}

// --- done: live popup embed --------------------------------------------------------

const popupFrame = $<HTMLIFrameElement>("popupFrame")

// Same-extension iframe → same-origin: size the frame to the popup's real height so the
// setup view (short) and the active view (sundial + gauge) both sit flush. The popup
// swaps views after async state fetches (and again when the user declares the goal), so
// a ResizeObserver on its body tracks every change; the 600px cap mirrors Chrome's own
// popup height limit, past which the real popup scrolls too.
let popupObserver: ResizeObserver | null = null
function resizePopupFrame(): void {
  try {
    const height = popupFrame.contentDocument?.body?.scrollHeight
    if (height) popupFrame.style.height = `${Math.min(600, Math.max(200, height + 8))}px`
  } catch {
    // Not readable (standalone preview) — keep the CSS default height.
  }
}
popupFrame.addEventListener("load", () => {
  resizePopupFrame()
  try {
    const body = popupFrame.contentDocument?.body
    if (!body) return
    popupObserver?.disconnect()
    popupObserver = new ResizeObserver(resizePopupFrame)
    popupObserver.observe(body)
  } catch {
    // Not observable (standalone preview) — the load-time resize above is the best effort.
  }
})

$("openSettingsDone").addEventListener("click", () => {
  if (extension) void chrome.runtime.openOptionsPage()
})
$("closeTab").addEventListener("click", () => {
  if (!extension) return window.close()
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id != null) return chrome.tabs.remove(tab.id)
    window.close()
  })
})

// --- live refresh loop -------------------------------------------------------------

// One slow tick keeps the visible step honest: AI status while the user is off
// connecting keys, pin state while they hover the puzzle menu (and as the polling
// fallback for Chromes without onUserSettingsChanged).
window.setInterval(() => {
  if (cur === STEP_AI) void refreshAiStatus()
  if (cur === STEP_PIN || cur === STEP_PERSONA) void refreshPin()
}, 2000)
window.addEventListener("focus", () => {
  if (cur === STEP_AI) void refreshAiStatus()
  if (cur === STEP_PIN || cur === STEP_PERSONA) void refreshPin()
})

// --- init --------------------------------------------------------------------------

void (async () => {
  const st = await send<WizardState>({ type: "get-state" })
  if (st?.persona && PERSONAS[st.persona]) currentPersona = st.persona
  renderPersonas()
  $("miniToastMsg").textContent = demoNagMessage()
})()
// Ask once up front so an already-pinned arrival (Chrome's auto-pin experiment, or a
// user who pinned on their own) sees the completed variant, never the instructions.
void refreshPin()
// Deep link: #step-N or ?step=N (0–6) opens on that step, so settings/docs links can
// jump straight to e.g. the AI-connect step. Anything else starts from the beginning.
const stepParam =
  new URLSearchParams(location.search).get("step") ?? /^#step-([0-6])$/.exec(location.hash)?.[1]
const initialStep = Number(stepParam ?? "0")
go(Number.isInteger(initialStep) && initialStep >= 0 && initialStep <= 6 ? initialStep : 0)

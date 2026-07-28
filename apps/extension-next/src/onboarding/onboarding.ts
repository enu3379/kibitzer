// Onboarding wizard — opened once by background.ts on first install. Reuses the real
// product pieces instead of forking them: the practice nag calls the actual toast
// renderer, the final step embeds the live popup in an iframe, persona copy comes from
// personas.data.ts, and the immersion band mapping is the popup's own bandOf().

import { showKibitzerToast } from "../content/toastOverlay.ts"
import { sundialSVG } from "../lib/sundial.ts"
import { bandOf } from "../lib/sessionStats.ts"
import { PERSONAS, PERSONA_ORDER, PERSONA_DEFAULT } from "../lib/personas.data.ts"

interface WizardState {
  persona?: string
  judgeEnabled?: boolean
  ollama?: { apiKeys?: string[]; tier1Model?: string; tier2Model?: string }
}

interface OllamaTestResult {
  ok: boolean
  tier1?: string
  tier2?: string
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

for (let i = 0; i < 5; i++) {
  const d = document.createElement("button")
  d.setAttribute("aria-label", `${i + 1}단계`)
  d.addEventListener("click", () => go(i))
  dots.appendChild(d)
}

function go(i: number): void {
  const leaving = cur
  cur = Math.max(0, Math.min(steps.length - 1, i))
  if (leaving === 3 && cur !== 3) void saveKeysIfEdited() // pasted a key, hit 다음 — keep it
  steps.forEach((s, j) => (s.hidden = j !== cur))
  ;[...dots.children].forEach((d, j) =>
    j === cur ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current"),
  )
  count.textContent = cur < 5 ? `${cur + 1} / 5` : "완료"
  prev.style.visibility = cur === 0 ? "hidden" : "visible"
  nav.style.display = cur === 5 ? "none" : "flex"
  next.textContent = cur === 4 ? "마무리 →" : "다음 →"
  if (cur === 3) void refreshAiStatus()
  if (cur === 4) void refreshPin()
}
prev.addEventListener("click", () => go(cur - 1))
next.addEventListener("click", () => go(cur + 1))

// --- persona copy (real fallback templates, demo context) --------------------------

const fillTemplate = (template: string, ctx: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => ctx[key] ?? "")

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

// --- step 4: Ollama Cloud connect (the options page's pane, inlined) ---------------

const aiStatus = $("aiStatus")
const aiStatusText = $("aiStatusText")
const keysInput = $<HTMLTextAreaElement>("keys")
const tier1Input = $<HTMLInputElement>("tier1")
const tier2Input = $<HTMLInputElement>("tier2")
const testKeys = $<HTMLButtonElement>("testKeys")
const keysResult = $("keysResult")
let savedSnapshot = "" // last state written via set-ollama, to skip no-op saves

const enteredKeys = (): string[] =>
  keysInput.value.split("\n").map((k) => k.trim()).filter(Boolean)
const keysSnapshot = (): string => JSON.stringify([enteredKeys(), tier1Input.value, tier2Input.value])

async function refreshAiStatus(): Promise<void> {
  const st = await send<WizardState>({ type: "get-state" })
  if (!st) return
  const on = Boolean(st.judgeEnabled ?? st.ollama?.apiKeys?.length)
  aiStatus.classList.toggle("on", on)
  aiStatusText.textContent = on
    ? "AI 판정 연결됨 ✓ — 페이지 내용까지 읽고 판정합니다"
    : "지금은 제목 판정만 동작 중 (Tier-0)"
}

async function saveKeys(): Promise<void> {
  await send({
    type: "set-ollama",
    apiKeys: enteredKeys(),
    tier1Model: tier1Input.value,
    tier2Model: tier2Input.value,
  })
  savedSnapshot = keysSnapshot()
  void refreshAiStatus()
}

async function saveKeysIfEdited(): Promise<void> {
  if (enteredKeys().length && keysSnapshot() !== savedSnapshot) await saveKeys()
}

testKeys.addEventListener("click", async () => {
  if (!enteredKeys().length) {
    keysResult.className = "result err"
    keysResult.textContent = "키가 비어 있어요. 위 링크에서 발급한 키를 붙여넣어 주세요."
    return
  }
  keysResult.className = "result"
  keysResult.textContent = "테스트 중… (첫 호출은 느릴 수 있어요)"
  testKeys.disabled = true
  const r = await send<OllamaTestResult>({
    type: "test-ollama",
    apiKeys: enteredKeys(),
    tier1Model: tier1Input.value,
    tier2Model: tier2Input.value,
  })
  testKeys.disabled = false
  if (r?.ok) {
    await saveKeys()
    keysResult.className = "result ok"
    keysResult.textContent = `연결 OK · ${r.tier1} · ${r.tier2} — 저장됐습니다 ✓`
  } else {
    keysResult.className = "result err"
    keysResult.textContent = `실패: ${r?.error ?? "응답 없음"}`
  }
})

const skip = $("skip")
skip.addEventListener("click", () => go(4))
skip.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") go(4)
})

// --- step 5: persona picker + toolbar-pin detection --------------------------------

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

function renderPersonas(): void {
  pgrid.innerHTML = ""
  for (const key of PERSONA_ORDER) {
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

const pinstate = $("pinstate")

// getUserSettings landed after our @types/chrome pin; feature-detect instead of typing.
type ActionUserSettings = { getUserSettings?: () => Promise<{ isOnToolbar?: boolean }> }

async function refreshPin(): Promise<void> {
  if (!extension) return
  try {
    const settings = await (chrome.action as unknown as ActionUserSettings).getUserSettings?.()
    if (!settings) return
    const on = Boolean(settings.isOnToolbar)
    pinstate.textContent = on ? "고정 감지됨 ✓" : "미고정"
    pinstate.classList.toggle("on", on)
  } catch {
    // API unavailable (old Chrome) — the hint stays useful without live detection.
  }
}

// --- done: live popup embed --------------------------------------------------------

const popupFrame = $<HTMLIFrameElement>("popupFrame")

// Same-extension iframe → same-origin: size the frame to the popup's real height so the
// setup view (short) and the active view (sundial + gauge) both sit flush.
function resizePopupFrame(): void {
  try {
    const height = popupFrame.contentDocument?.body?.scrollHeight
    if (height) popupFrame.style.height = `${Math.min(560, Math.max(200, height + 8))}px`
  } catch {
    // Not readable (standalone preview) — keep the CSS default height.
  }
}
popupFrame.addEventListener("load", resizePopupFrame)

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
// connecting keys, pin state while they hover the puzzle menu, popup height always.
window.setInterval(() => {
  if (cur === 3) void refreshAiStatus()
  if (cur === 4) void refreshPin()
  if (cur === 5) resizePopupFrame()
}, 2000)
window.addEventListener("focus", () => {
  if (cur === 3) void refreshAiStatus()
  if (cur === 4) void refreshPin()
})

// --- init --------------------------------------------------------------------------

void (async () => {
  const st = await send<WizardState>({ type: "get-state" })
  if (st?.persona && PERSONAS[st.persona]) currentPersona = st.persona
  if (st?.ollama) {
    keysInput.value = (st.ollama.apiKeys ?? []).join("\n")
    tier1Input.value = st.ollama.tier1Model ?? ""
    tier2Input.value = st.ollama.tier2Model ?? ""
    savedSnapshot = keysSnapshot()
  }
  renderPersonas()
  $("miniToastMsg").textContent = demoNagMessage()
})()
// Deep link: #step-N or ?step=N (0–5) opens on that step, so settings/docs links can
// jump straight to e.g. the AI-connect step. Anything else starts from the beginning.
const stepParam =
  new URLSearchParams(location.search).get("step") ?? /^#step-([0-5])$/.exec(location.hash)?.[1]
const initialStep = Number(stepParam ?? "0")
go(Number.isInteger(initialStep) && initialStep >= 0 && initialStep <= 5 ? initialStep : 0)

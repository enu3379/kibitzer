// Options page: sensitivity, quiet hours, voice, persona, Ollama Cloud, and data controls.
// All state lives in the service worker; this page just reads/writes via messages.

import {
  SENSITIVITY_PRESETS,
  sensitivityLevelFor,
  type SensitivityLevel,
  type Settings,
} from "../lib/settings.ts"

interface StateResponse {
  persona?: string
  personas?: Array<{ key: string; name: string }>
  ollama?: { apiKeys: string[]; tier1Model: string; tier2Model: string }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const sens = $<HTMLElement>("sens")
const sensHint = $<HTMLElement>("sensHint")
const quietSw = $<HTMLButtonElement>("quietSw")
const quietStart = $<HTMLInputElement>("quietStart")
const quietEnd = $<HTMLInputElement>("quietEnd")
const ttsSw = $<HTMLButtonElement>("ttsSw")
const pgrid = $<HTMLElement>("pgrid")
const keys = $<HTMLTextAreaElement>("keys")
const tier1 = $<HTMLInputElement>("tier1")
const tier2 = $<HTMLInputElement>("tier2")
const testBtn = $<HTMLButtonElement>("test")
const saveOllama = $<HTMLButtonElement>("saveOllama")
const ollamaResult = $<HTMLElement>("ollamaResult")
const exportLog = $<HTMLButtonElement>("exportLog")
const exportEvents = $<HTMLButtonElement>("exportEvents")
const wipe = $<HTMLButtonElement>("wipe")

const send = (msg: unknown): Promise<unknown> => chrome.runtime.sendMessage(msg)
const setChecked = (el: HTMLElement, on: boolean): void => el.setAttribute("aria-checked", String(on))
const isChecked = (el: HTMLElement): boolean => el.getAttribute("aria-checked") === "true"

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await send({ type: "set-settings", settings: patch })
}

const SENS_HINTS: Record<SensitivityLevel, string> = {
  lenient: "확실히 벗어났을 때만 이탈로 봅니다. 훈수가 줄어듭니다.",
  standard: "권장 기본값 — 벤치마크로 맞춘 균형점입니다.",
  strict: "조금만 벗어나도 이탈로 봅니다. 훈수가 잦아질 수 있습니다.",
}

function renderSensitivity(level: SensitivityLevel): void {
  sens.querySelectorAll<HTMLElement>(".segbtn").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.level === level)),
  )
  sensHint.textContent = SENS_HINTS[level]
}

// --- init ------------------------------------------------------------------------

async function init(): Promise<void> {
  const settings = (await send({ type: "get-settings" })) as Settings
  renderSensitivity(sensitivityLevelFor(settings.tauOk))
  setChecked(quietSw, settings.quietHours.enabled)
  quietStart.value = settings.quietHours.start
  quietEnd.value = settings.quietHours.end
  quietStart.disabled = quietEnd.disabled = !settings.quietHours.enabled
  setChecked(ttsSw, settings.ttsEnabled)

  const state = (await send({ type: "get-state" })) as StateResponse
  if (state?.personas) {
    pgrid.innerHTML = ""
    for (const p of state.personas) {
      const b = document.createElement("button")
      b.className = "pcard"
      b.setAttribute("aria-pressed", String(p.key === state.persona))
      b.dataset.key = p.key
      b.innerHTML = `<span class="pn">${p.name}</span>`
      b.addEventListener("click", async () => {
        await send({ type: "set-persona", persona: p.key })
        pgrid.querySelectorAll<HTMLElement>(".pcard").forEach((c) =>
          c.setAttribute("aria-pressed", String(c === b)),
        )
      })
      pgrid.appendChild(b)
    }
  }
  if (state?.ollama) {
    keys.value = (state.ollama.apiKeys ?? []).join("\n")
    tier1.value = state.ollama.tier1Model ?? ""
    tier2.value = state.ollama.tier2Model ?? ""
  }
}

// --- wiring ----------------------------------------------------------------------

sens.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) =>
  b.addEventListener("click", () => {
    const level = b.dataset.level as SensitivityLevel
    renderSensitivity(level)
    void saveSettings({ tauOk: SENSITIVITY_PRESETS[level] })
  }),
)

quietSw.addEventListener("click", () => {
  const on = !isChecked(quietSw)
  setChecked(quietSw, on)
  quietStart.disabled = quietEnd.disabled = !on
  void saveSettings({ quietHours: { enabled: on, start: quietStart.value, end: quietEnd.value } })
})
const saveQuiet = (): void =>
  void saveSettings({ quietHours: { enabled: isChecked(quietSw), start: quietStart.value, end: quietEnd.value } })
quietStart.addEventListener("change", saveQuiet)
quietEnd.addEventListener("change", saveQuiet)

ttsSw.addEventListener("click", () => {
  const on = !isChecked(ttsSw)
  setChecked(ttsSw, on)
  void saveSettings({ ttsEnabled: on })
})

function enteredKeys(): string[] {
  return keys.value.split("\n").map((k) => k.trim()).filter(Boolean)
}

saveOllama.addEventListener("click", async () => {
  await send({ type: "set-ollama", apiKeys: enteredKeys(), tier1Model: tier1.value, tier2Model: tier2.value })
  saveOllama.textContent = "저장됨 ✓"
  setTimeout(() => (saveOllama.textContent = "저장"), 1200)
})

testBtn.addEventListener("click", async () => {
  ollamaResult.className = "hint"
  ollamaResult.textContent = "테스트 중… (첫 호출은 느릴 수 있어요)"
  const r = (await send({
    type: "test-ollama",
    apiKeys: enteredKeys(),
    tier1Model: tier1.value,
    tier2Model: tier2.value,
  })) as { ok: boolean; tier1?: string; tier2?: string; error?: string } | undefined
  if (r?.ok) {
    ollamaResult.className = "hint ok"
    ollamaResult.textContent = `연결 OK · ${r.tier1} · ${r.tier2}`
  } else {
    ollamaResult.className = "hint err"
    ollamaResult.textContent = `실패: ${r?.error ?? "응답 없음"}`
  }
})

const exportClick = (btn: HTMLButtonElement, type: string, label: string) =>
  btn.addEventListener("click", async () => {
    const r = (await send({ type })) as { ok: boolean } | undefined
    btn.textContent = r?.ok ? "저장됨 ✓" : "실패"
    setTimeout(() => (btn.textContent = label), 1200)
  })
exportClick(exportLog, "export-log", "디버그 로그 파일")
exportClick(exportEvents, "export-events", "이벤트 JSON")

$<HTMLButtonElement>("openReplay").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("replay/replay.html") })
})

wipe.addEventListener("click", async () => {
  if (!confirm("모든 활동 데이터(게이지·이력·학습·이벤트·나깅)를 삭제할까요? 목표·키·말투는 유지됩니다.")) return
  await send({ type: "delete-all-data" })
  wipe.textContent = "삭제됨 ✓"
  setTimeout(() => (wipe.textContent = "삭제"), 1500)
})

void init()

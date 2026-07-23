// Popup: setup (goal + time + Ollama Cloud) when no goal; active (S + goal + mode) once set.

interface OllamaConfig {
  apiUrl: string
  apiKeys: string[]
  tier1Model: string
  tier2Model: string
}

interface StateResponse {
  goal: { text: string; availableMinutes: number | null } | null
  s: number
  accelTier: number
  ollama?: OllamaConfig
  persona?: string
  personas?: Array<{ key: string; name: string }>
}

const activeView = document.getElementById("active") as HTMLDivElement
const setupView = document.getElementById("setup") as HTMLDivElement
const gaugeEl = document.getElementById("gauge") as HTMLDivElement
const goalTextEl = document.getElementById("goalText") as HTMLElement
const modeEl = document.getElementById("mode") as HTMLElement
const personaActiveEl = document.getElementById("personaActive") as HTMLElement
const personaSelect = document.getElementById("persona") as HTMLSelectElement
const goalInput = document.getElementById("goal") as HTMLInputElement
const minutesInput = document.getElementById("minutes") as HTMLInputElement
const startButton = document.getElementById("set") as HTMLButtonElement
const editButton = document.getElementById("edit") as HTMLButtonElement
const keysInput = document.getElementById("ollama-keys") as HTMLTextAreaElement
const tier1Input = document.getElementById("ollama-tier1") as HTMLInputElement
const tier2Input = document.getElementById("ollama-tier2") as HTMLInputElement
const saveOllamaButton = document.getElementById("save-ollama") as HTMLButtonElement
const testButton = document.getElementById("test-ollama") as HTMLButtonElement
const resultEl = document.getElementById("ollama-result") as HTMLDivElement

function enteredKeys(): string[] {
  return keysInput.value.split("\n").map((k) => k.trim()).filter(Boolean)
}

let current: StateResponse | null = null

async function getState(): Promise<StateResponse | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: "get-state" })) as StateResponse
  } catch {
    return null
  }
}

function modeText(state: StateResponse): string {
  const ollama = state.ollama
  if (ollama && ollama.apiKeys?.length) {
    return `LLM 판정: ${ollama.tier2Model} · 키 ${ollama.apiKeys.length}개`
  }
  return "제목 유사도만 (LLM 꺼짐)"
}

function personaName(state: StateResponse): string {
  const found = state.personas?.find((p) => p.key === state.persona)
  return found ? `말투 · ${found.name}` : ""
}

function fillSettings(state: StateResponse | null): void {
  if (state?.goal) {
    goalInput.value = state.goal.text
    minutesInput.value = state.goal.availableMinutes != null ? String(state.goal.availableMinutes) : ""
  }
  if (state?.personas) {
    personaSelect.innerHTML = ""
    for (const p of state.personas) {
      const opt = document.createElement("option")
      opt.value = p.key
      opt.textContent = p.name
      personaSelect.appendChild(opt)
    }
    if (state.persona) personaSelect.value = state.persona
  }
  if (state?.ollama) {
    keysInput.value = (state.ollama.apiKeys ?? []).join("\n")
    tier1Input.value = state.ollama.tier1Model ?? ""
    tier2Input.value = state.ollama.tier2Model ?? ""
  }
}

function showSetup(): void {
  setupView.hidden = false
  activeView.hidden = true
  fillSettings(current)
  goalInput.focus()
}

function showActive(state: StateResponse): void {
  activeView.hidden = false
  setupView.hidden = true
  goalTextEl.textContent = state.goal?.text ?? ""
  gaugeEl.innerHTML = `${state.s}<small> / 100 몰입</small>`
  modeEl.textContent = modeText(state)
  personaActiveEl.textContent = personaName(state)
}

function render(state: StateResponse | null): void {
  current = state
  if (state?.goal) showActive(state)
  else showSetup()
}

startButton.addEventListener("click", async () => {
  const rawMinutes = minutesInput.value.trim()
  const minutes = rawMinutes ? Number.parseInt(rawMinutes, 10) : null
  await chrome.runtime.sendMessage({
    type: "set-goal",
    goal: goalInput.value,
    minutes: Number.isFinite(minutes) ? minutes : null,
  })
  render(await getState())
})

saveOllamaButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "set-ollama",
    apiKeys: enteredKeys(),
    tier1Model: tier1Input.value,
    tier2Model: tier2Input.value,
  })
  current = await getState()
  saveOllamaButton.textContent = "저장됨 ✓"
  setTimeout(() => { saveOllamaButton.textContent = "저장" }, 1200)
})

testButton.addEventListener("click", async () => {
  resultEl.className = "hint"
  resultEl.textContent = "테스트 중… (LLM 첫 호출은 느릴 수 있어요)"
  const result = (await chrome.runtime.sendMessage({
    type: "test-ollama",
    apiKeys: enteredKeys(),
    tier1Model: tier1Input.value,
    tier2Model: tier2Input.value,
  })) as { ok: boolean; tier1?: string; tier2?: string; error?: string } | undefined
  if (result?.ok) {
    resultEl.className = "hint ok"
    resultEl.textContent = `연결 OK · ${result.tier1} · ${result.tier2}`
  } else {
    resultEl.className = "hint err"
    resultEl.textContent = `실패: ${result?.error ?? "응답 없음"}`
  }
})

personaSelect.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "set-persona", persona: personaSelect.value })
  current = await getState()
  if (current) personaActiveEl.textContent = personaName(current)
})

// --- debug log panel -------------------------------------------------------------

const logBox = document.getElementById("logbox") as HTMLDetailsElement
const logView = document.getElementById("logview") as HTMLElement
const logRefresh = document.getElementById("log-refresh") as HTMLButtonElement
const logExport = document.getElementById("log-export") as HTMLButtonElement
const logClear = document.getElementById("log-clear") as HTMLButtonElement

async function refreshLog(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: "get-log" })) as { text?: string } | undefined
  logView.textContent = res?.text || "(비어 있음)"
  logView.scrollTop = logView.scrollHeight
}

logRefresh.addEventListener("click", refreshLog)
logExport.addEventListener("click", async () => {
  const res = (await chrome.runtime.sendMessage({ type: "export-log" })) as { ok: boolean; error?: string } | undefined
  logExport.textContent = res?.ok ? "저장됨 ✓" : "실패"
  setTimeout(() => { logExport.textContent = "파일로" }, 1200)
})
logClear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear-log" })
  await refreshLog()
})
// Auto-load the log when the panel is opened, then poll while it stays open.
logBox.addEventListener("toggle", () => { if (logBox.open) void refreshLog() })
setInterval(() => { if (logBox.open) void refreshLog() }, 2000)

editButton.addEventListener("click", () => {
  showSetup()
})

void getState().then(render)

// Live update: refresh S every 1.5s while the gauge is showing.
setInterval(async () => {
  if (activeView.hidden) return
  const state = await getState()
  if (!state?.goal) return
  current = state
  gaugeEl.innerHTML = `${state.s}<small> / 100 몰입</small>`
  goalTextEl.textContent = state.goal.text
  modeEl.textContent = modeText(state)
  personaActiveEl.textContent = personaName(state)
}, 1500)

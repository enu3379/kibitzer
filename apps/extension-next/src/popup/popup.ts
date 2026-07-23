// Popup: setup (goal + time + Ollama) when no goal; active (S + goal + mode) once set.

interface OllamaConfig {
  apiUrl: string
  model: string
}

interface StateResponse {
  goal: { text: string; availableMinutes: number | null } | null
  s: number
  accelTier: number
  ollama: OllamaConfig | null
}

const activeView = document.getElementById("active") as HTMLDivElement
const setupView = document.getElementById("setup") as HTMLDivElement
const gaugeEl = document.getElementById("gauge") as HTMLDivElement
const goalTextEl = document.getElementById("goalText") as HTMLElement
const modeEl = document.getElementById("mode") as HTMLElement
const goalInput = document.getElementById("goal") as HTMLInputElement
const minutesInput = document.getElementById("minutes") as HTMLInputElement
const startButton = document.getElementById("set") as HTMLButtonElement
const editButton = document.getElementById("edit") as HTMLButtonElement
const ollamaModelInput = document.getElementById("ollama-model") as HTMLInputElement
const ollamaUrlInput = document.getElementById("ollama-url") as HTMLInputElement
const saveOllamaButton = document.getElementById("save-ollama") as HTMLButtonElement

let current: StateResponse | null = null

async function getState(): Promise<StateResponse | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: "get-state" })) as StateResponse
  } catch {
    return null
  }
}

function fillSettings(state: StateResponse | null): void {
  if (state?.goal) {
    goalInput.value = state.goal.text
    minutesInput.value = state.goal.availableMinutes != null ? String(state.goal.availableMinutes) : ""
  }
  if (state?.ollama) {
    ollamaModelInput.value = state.ollama.model
    ollamaUrlInput.value = state.ollama.apiUrl
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
  modeEl.textContent = state.ollama ? `LLM 판정: ${state.ollama.model}` : "제목 유사도만 (LLM 꺼짐)"
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
    apiUrl: ollamaUrlInput.value,
    model: ollamaModelInput.value,
  })
  const state = await getState()
  current = state
  saveOllamaButton.textContent = "저장됨 ✓"
  setTimeout(() => { saveOllamaButton.textContent = "Ollama 저장" }, 1200)
})

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
  modeEl.textContent = state.ollama ? `LLM 판정: ${state.ollama.model}` : "제목 유사도만 (LLM 꺼짐)"
}, 1500)

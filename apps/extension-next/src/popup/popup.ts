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
const keysInput = document.getElementById("ollama-keys") as HTMLTextAreaElement
const tier1Input = document.getElementById("ollama-tier1") as HTMLInputElement
const tier2Input = document.getElementById("ollama-tier2") as HTMLInputElement
const saveOllamaButton = document.getElementById("save-ollama") as HTMLButtonElement

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
  const keys = ollama?.apiKeys?.length ?? 0
  return keys > 0 ? `LLM 판정: ${ollama.tier2Model} · 키 ${keys}개` : "제목 유사도만 (LLM 꺼짐)"
}

function fillSettings(state: StateResponse | null): void {
  if (state?.goal) {
    goalInput.value = state.goal.text
    minutesInput.value = state.goal.availableMinutes != null ? String(state.goal.availableMinutes) : ""
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
    apiKeys: keysInput.value.split("\n").map((k) => k.trim()).filter(Boolean),
    tier1Model: tier1Input.value,
    tier2Model: tier2Input.value,
  })
  current = await getState()
  saveOllamaButton.textContent = "저장됨 ✓"
  setTimeout(() => { saveOllamaButton.textContent = "저장" }, 1200)
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
  modeEl.textContent = modeText(state)
}, 1500)

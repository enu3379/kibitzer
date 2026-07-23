// Popup: setup (goal + time) when no goal; active (S + goal + mode) once set.
// Settings, persona, Ollama, and debug tools live on the options page.

interface StateResponse {
  goal: { text: string; availableMinutes: number | null } | null
  s: number
  accelTier: number
  ollama?: { apiKeys: string[]; tier1Model: string; tier2Model: string }
  persona?: string
  personas?: Array<{ key: string; name: string }>
  health?: { ok: boolean; kind: string; message: string; ts: number } | null
}

const activeView = document.getElementById("active") as HTMLDivElement
const setupView = document.getElementById("setup") as HTMLDivElement
const gaugeEl = document.getElementById("gauge") as HTMLDivElement
const goalTextEl = document.getElementById("goalText") as HTMLElement
const modeEl = document.getElementById("mode") as HTMLElement
const personaActiveEl = document.getElementById("personaActive") as HTMLElement
const providerWarnEl = document.getElementById("providerWarn") as HTMLElement
const goalInput = document.getElementById("goal") as HTMLInputElement
const minutesInput = document.getElementById("minutes") as HTMLInputElement
const startButton = document.getElementById("set") as HTMLButtonElement
const editButton = document.getElementById("edit") as HTMLButtonElement

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

function renderProviderWarn(state: StateResponse): void {
  const ollamaOn = Boolean(state.ollama?.apiKeys?.length)
  const health = state.health
  if (ollamaOn && health && !health.ok) {
    providerWarnEl.textContent = `⚠ LLM 오류: ${health.message} · Tier-0(제목 유사도)만 동작 중`
    providerWarnEl.hidden = false
  } else {
    providerWarnEl.hidden = true
  }
}

function showSetup(): void {
  setupView.hidden = false
  activeView.hidden = true
  if (current?.goal) {
    goalInput.value = current.goal.text
    minutesInput.value = current.goal.availableMinutes != null ? String(current.goal.availableMinutes) : ""
  }
  goalInput.focus()
}

function showActive(state: StateResponse): void {
  activeView.hidden = false
  setupView.hidden = true
  goalTextEl.textContent = state.goal?.text ?? ""
  gaugeEl.innerHTML = `${state.s}<small> / 100 몰입</small>`
  modeEl.textContent = modeText(state)
  personaActiveEl.textContent = personaName(state)
  renderProviderWarn(state)
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

editButton.addEventListener("click", showSetup)
for (const id of ["openSettings", "openSettings2"]) {
  document.getElementById(id)?.addEventListener("click", () => chrome.runtime.openOptionsPage())
}

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
  renderProviderWarn(state)
}, 1500)

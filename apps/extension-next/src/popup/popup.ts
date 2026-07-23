// Popup: two states. No goal → setup (input + 시작). Goal set → active (S + goal + 변경).

interface StateResponse {
  goal: { text: string; availableMinutes: number | null } | null
  s: number
  accelTier: number
}

const activeView = document.getElementById("active") as HTMLDivElement
const setupView = document.getElementById("setup") as HTMLDivElement
const gaugeEl = document.getElementById("gauge") as HTMLDivElement
const goalTextEl = document.getElementById("goalText") as HTMLElement
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

editButton.addEventListener("click", () => {
  showSetup()
})

void getState().then(render)

// Live update: while the popup is open and showing the gauge, refresh S every
// 1.5s (get-state advances the gauge to now on the background side).
setInterval(async () => {
  if (activeView.hidden) return
  const state = await getState()
  if (!state?.goal) return
  current = state
  gaugeEl.innerHTML = `${state.s}<small> / 100 몰입</small>`
  goalTextEl.textContent = state.goal.text
}, 1500)

// Minimal popup: set the goal, show the current immersion gauge S.

interface StateResponse {
  goal: { text: string; availableMinutes: number | null } | null
  s: number
  accelTier: number
}

const gaugeEl = document.getElementById("gauge") as HTMLDivElement
const goalEl = document.getElementById("goal") as HTMLInputElement
const minutesEl = document.getElementById("minutes") as HTMLInputElement
const setButton = document.getElementById("set") as HTMLButtonElement

async function getState(): Promise<StateResponse | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: "get-state" })) as StateResponse
  } catch {
    return null
  }
}

function render(state: StateResponse | null): void {
  if (!state?.goal) {
    gaugeEl.innerHTML = `<small>목표를 정하면 시작해요</small>`
    return
  }
  goalEl.value = state.goal.text
  if (state.goal.availableMinutes != null) minutesEl.value = String(state.goal.availableMinutes)
  gaugeEl.innerHTML = `${state.s}<small> / 100 몰입</small>`
}

setButton.addEventListener("click", async () => {
  const rawMinutes = minutesEl.value.trim()
  const minutes = rawMinutes ? Number.parseInt(rawMinutes, 10) : null
  await chrome.runtime.sendMessage({
    type: "set-goal",
    goal: goalEl.value,
    minutes: Number.isFinite(minutes) ? minutes : null,
  })
  render(await getState())
})

void getState().then(render)

// The gauge, wired to run for real. Holds the immersion state in chrome.storage.session
// (survives service-worker teardown within a browser session), serializes dispatches,
// and delivers nag/celebrate effects as Chrome notifications.
//
// First slice runs Tier-0-only, i.e. the gauge's degraded mode: no Tier 2 LLM gate, so
// S=0 nags directly. request_tier2 effects are ignored until the Ollama layer lands.

import { reduceGauge } from "../core/gauge/reducer.ts"
import { defaultGaugeConfig } from "../core/gauge/config.ts"
import { initGaugeState } from "../core/gauge/types.ts"
import type { GaugeConfig, GaugeEffect, GaugeEvent, GaugeState } from "../core/gauge/types.ts"
import type { SessionGoal } from "./session.ts"

const STATE_KEY = "kibitzer:gauge-state:v1"

function isGaugeState(value: unknown): value is GaugeState {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as GaugeState).s === "number" &&
    typeof (value as GaugeState).m === "number" &&
    typeof (value as GaugeState).accelTier === "number"
  )
}

async function loadState(): Promise<GaugeState> {
  const stored = await chrome.storage.session.get(STATE_KEY)
  const value = stored[STATE_KEY]
  return isGaugeState(value) ? value : initGaugeState()
}

async function saveState(state: GaugeState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state })
}

export async function currentState(): Promise<GaugeState> {
  return loadState()
}

export async function resetState(): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: initGaugeState() })
}

function configFor(goal: SessionGoal | null): GaugeConfig {
  return defaultGaugeConfig(goal?.availableMinutes ?? null)
}

let queue: Promise<void> = Promise.resolve()

/** Apply one gauge event (serialized), persist the state, and deliver any effects. */
export function dispatch(event: GaugeEvent, goal: SessionGoal | null): Promise<void> {
  const task = async (): Promise<void> => {
    const state = await loadState()
    const transition = reduceGauge(state, event, configFor(goal))
    await saveState(transition.state)
    for (const effect of transition.effects) {
      await deliver(effect, goal)
    }
  }
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

async function deliver(effect: GaugeEffect, goal: SessionGoal | null): Promise<void> {
  const goalText = goal?.text ?? "목표"
  if (effect.type === "nag") {
    await notify("nag", `'${goalText}'에서 벗어난 것 같아요`, "잠깐 — 지금 하려던 걸 확인해볼까요?")
  } else if (effect.type === "celebrate") {
    await notify("celebrate", "돌아왔네요 👍", `'${goalText}'에 다시 집중하고 있어요.`)
  }
  // "request_tier2" effects need the Ollama layer (next PR); ignored in this slice.
}

async function notify(kind: string, title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create(`kibitzer-${kind}-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
      priority: 1,
    })
  } catch {
    // Notifications may be unavailable (permissions, headless); the gauge state is
    // already persisted, so this only drops the surfacing, not the accounting.
  }
}

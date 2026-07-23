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
import { showKibitzerToast, type ToastPayload } from "../content/toastOverlay.ts"
import { tier2Confirm } from "./tier12.ts"
import { activePersona, pickCelebrate } from "./personas.ts"
import type { SessionGoal } from "./session.ts"

const STATE_KEY = "kibitzer:gauge-state:v1"
const ACTIVE_PAGE_KEY = "kibitzer:active-page:v1"
const NAG_COUNT_KEY = "kibitzer:nag-count:v1"
const DRIFT_SINCE_KEY = "kibitzer:drift-since:v1"

export interface ActivePage {
  pageKey: string
  title: string
  urlHost: string
  score: number
}

/** Remember the active page's details so the async Tier 2 gate can judge it. */
export async function setActivePage(page: ActivePage): Promise<void> {
  await chrome.storage.session.set({ [ACTIVE_PAGE_KEY]: page })
}

async function getActivePage(): Promise<ActivePage | null> {
  const stored = await chrome.storage.session.get(ACTIVE_PAGE_KEY)
  const value = stored[ACTIVE_PAGE_KEY] as ActivePage | undefined
  return value && typeof value.pageKey === "string" ? value : null
}

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
  await chrome.storage.session.set({
    [STATE_KEY]: initGaugeState(),
    [NAG_COUNT_KEY]: 0,
    [DRIFT_SINCE_KEY]: null,
  })
}

// --- persona message context (nag ordinal + time-away) ---------------------------

async function getNagCount(): Promise<number> {
  const stored = await chrome.storage.session.get(NAG_COUNT_KEY)
  const value = stored[NAG_COUNT_KEY]
  return typeof value === "number" ? value : 0
}

async function bumpNagCount(): Promise<void> {
  await chrome.storage.session.set({ [NAG_COUNT_KEY]: (await getNagCount()) + 1 })
}

async function setDriftSince(ts: number | null): Promise<void> {
  await chrome.storage.session.set({ [DRIFT_SINCE_KEY]: ts })
}

/** Minutes since drift began (≥1), for the persona celebration templates. */
async function returnMinutes(now: number): Promise<number> {
  const stored = await chrome.storage.session.get(DRIFT_SINCE_KEY)
  const since = stored[DRIFT_SINCE_KEY]
  if (typeof since !== "number") return 1
  return Math.max(1, Math.round((now - since) / 60_000))
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
    // Diagnostic trace (service-worker console): watch S drain/recover and why an
    // effect fired. Remove once the pipeline is trusted.
    const s0 = state.s.toFixed(1)
    const s1 = transition.state.s.toFixed(1)
    if (s0 !== s1 || transition.effects.length > 0) {
      const eff = transition.effects.map((e) => e.type).join(",")
      console.log(
        `[kbz] ${event.type} S ${s0}->${s1} m=${transition.state.m.toFixed(2)}` +
          ` armed=${transition.state.celebrateArmed} v=${transition.state.activeVerdict}` +
          (eff ? ` !! ${eff}` : ""),
      )
    }
    await saveState(transition.state)
    // Mark when a drift episode began, so the celebration can say how long they were away.
    if (state.activeVerdict !== "DRIFT" && transition.state.activeVerdict === "DRIFT") {
      await setDriftSince(event.ts)
    }
    for (const effect of transition.effects) {
      await deliver(effect, goal, event.ts)
    }
  }
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Fire a nag notification immediately, for manual testing (goal = "알림보기"). */
export async function testNag(goal: SessionGoal | null): Promise<void> {
  await deliver({ type: "nag", pageKey: "test" }, goal, Date.now())
}

let pendingNagMessage: string | null = null

async function deliver(effect: GaugeEffect, goal: SessionGoal | null, ts: number): Promise<void> {
  const goalText = goal?.text ?? "목표"
  if (effect.type === "request_tier2") {
    // Service the Tier 2 gate off the dispatch queue (Ollama is slow); it dispatches
    // a tier2_result back into the gauge when it resolves.
    void serviceTier2(effect, goal)
    return
  }
  if (effect.type === "nag") {
    const message = pendingNagMessage
      ?? `'${goalText}' 흐름에서 벗어난 것 같아요. 계속 필요한 곁가지인지 확인해볼까요?`
    pendingNagMessage = null
    await bumpNagCount()
    await showToast(message, effect.pageKey, "intervention")
  } else if (effect.type === "celebrate") {
    // Celebrate in the selected persona's voice; fall back to the plain line.
    const persona = await activePersona()
    const message =
      pickCelebrate(persona, { goal: goalText, returnMinutes: await returnMinutes(ts) }) ??
      `'${goalText}'에 다시 집중하고 있네요 👍`
    await setDriftSince(null)
    await showToast(message, null, "celebration")
  }
}

async function serviceTier2(
  effect: Extract<GaugeEffect, { type: "request_tier2" }>,
  goal: SessionGoal | null,
): Promise<void> {
  const page = await getActivePage()
  if (!page || page.pageKey !== effect.pageKey) return
  // The nag we're about to (maybe) produce is the next ordinal — drives persona flavor.
  const nagCount = (await getNagCount()) + 1
  const outcome = await tier2Confirm(goal?.text ?? "", page, { nagCount })
  console.log(`[kbz] tier2 gate (${effect.reason}) on ${effect.pageKey} -> ${outcome.flow}`)
  // The Writer's message rides along to the nag toast (if drift is confirmed).
  if (outcome.flow === "drift" && outcome.message) pendingNagMessage = outcome.message
  await dispatch(
    { type: "tier2_result", flow: outcome.flow, pageKey: effect.pageKey, ts: Date.now() },
    goal,
  )
}

let toastToken = 0

/** Render the in-page toast overlay in the active tab (matches apps/extension —
 *  a quiet on-page bubble, not an OS notification). Injected via executeScript. */
async function showToast(
  message: string,
  contextLabel: string | null,
  kind: "intervention" | "celebration",
): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) return
  const payload: ToastPayload = {
    notificationId: `kbz-${Date.now()}`,
    displayToken: (toastToken += 1),
    message,
    contextLabel,
    autoDismissMs: 12_000,
    kind,
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showKibitzerToast,
      args: [payload],
    })
  } catch {
    // Some pages (chrome://, the web store) block injection — skip silently.
  }
}

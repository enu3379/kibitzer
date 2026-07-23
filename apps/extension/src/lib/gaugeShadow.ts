import { defaultGaugeConfig } from "../core/gauge/config.ts"
import { reduceGauge } from "../core/gauge/reducer.ts"
import { initGaugeState } from "../core/gauge/types.ts"
import type { GaugeEffect, GaugeEvent, GaugeState } from "../core/gauge/types.ts"

export const GAUGE_SHADOW_STORAGE_KEY = "kibitzer:gauge-shadow:v1"
export const GAUGE_SHADOW_MAX_EFFECTS = 50

export interface GaugeShadowEffectRecord {
  ts: number
  sourceEvent: GaugeEvent["type"]
  effect: GaugeEffect
}

export interface GaugeShadowSnapshot {
  version: 1
  sessionId: string
  goalMinutes: number | null
  state: GaugeState
  effectLog: GaugeShadowEffectRecord[]
  eventCount: number
  lastEvent: { type: GaugeEvent["type"]; ts: number } | null
}

export interface GaugeShadowStorage {
  load(): Promise<unknown>
  save(snapshot: GaugeShadowSnapshot): Promise<void>
  clear(): Promise<void>
}

/**
 * Phase-2-only shadow runner. It serializes reducer transitions and persists a
 * diagnostic snapshot, but deliberately has no callback that could deliver a
 * reducer effect. IndexedDB ownership and an effect outbox belong to Phase 3.
 */
export class GaugeShadowController {
  private readonly storage: GaugeShadowStorage
  private tail: Promise<void> = Promise.resolve()
  private loaded = false
  private current: GaugeShadowSnapshot | null = null

  constructor(storage: GaugeShadowStorage) {
    this.storage = storage
  }

  ensureSession(
    sessionId: string,
    goalMinutes: number | null,
    ts: number,
    forceReset = false,
  ): Promise<GaugeShadowSnapshot> {
    return this.run(async () => {
      await this.loadOnce()
      if (forceReset || this.current?.sessionId !== sessionId) {
        const state = initGaugeState()
        this.current = {
          version: 1,
          sessionId,
          goalMinutes: normalizeGoalMinutes(goalMinutes),
          state: { ...state, updatedAt: ts },
          effectLog: [],
          eventCount: 0,
          lastEvent: null,
        }
        await this.storage.save(this.current)
      }
      return this.current
    })
  }

  dispatch(event: GaugeEvent): Promise<GaugeShadowSnapshot | null> {
    return this.run(async () => {
      await this.loadOnce()
      if (!this.current) return null

      const transition = reduceGauge(
        this.current.state,
        event,
        defaultGaugeConfig(this.current.goalMinutes),
      )
      const recorded = transition.effects.map((effect) => ({
        ts: event.ts,
        sourceEvent: event.type,
        effect,
      }))
      this.current = {
        ...this.current,
        state: transition.state,
        effectLog: [...this.current.effectLog, ...recorded].slice(-GAUGE_SHADOW_MAX_EFFECTS),
        eventCount: this.current.eventCount + 1,
        lastEvent: { type: event.type, ts: event.ts },
      }
      await this.storage.save(this.current)
      return this.current
    })
  }

  snapshot(sessionId?: string): Promise<GaugeShadowSnapshot | null> {
    return this.run(async () => {
      await this.loadOnce()
      if (sessionId && this.current?.sessionId !== sessionId) return null
      return this.current
    })
  }

  clear(): Promise<void> {
    return this.run(async () => {
      this.loaded = true
      this.current = null
      await this.storage.clear()
    })
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) return
    const stored = await this.storage.load()
    this.current = isGaugeShadowSnapshot(stored) ? stored : null
    this.loaded = true
  }
}

function normalizeGoalMinutes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  return value
}

function isGaugeShadowSnapshot(value: unknown): value is GaugeShadowSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Partial<GaugeShadowSnapshot>
  if (
    snapshot.version !== 1
    || typeof snapshot.sessionId !== "string"
    || (snapshot.goalMinutes !== null && typeof snapshot.goalMinutes !== "number")
    || !snapshot.state
    || typeof snapshot.state.s !== "number"
    || typeof snapshot.state.m !== "number"
    || typeof snapshot.state.accelTier !== "number"
    || typeof snapshot.state.updatedAt !== "number"
    || !Array.isArray(snapshot.effectLog)
    || typeof snapshot.eventCount !== "number"
  ) return false
  return snapshot.lastEvent === null || Boolean(
    snapshot.lastEvent
    && typeof snapshot.lastEvent.type === "string"
    && typeof snapshot.lastEvent.ts === "number",
  )
}

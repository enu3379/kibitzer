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
  version: 2
  sessionId: string
  goalMinutes: number | null
  state: GaugeState
  effectLog: GaugeShadowEffectRecord[]
  outboxCount: number
  eventCount: number
  lastEvent: { type: GaugeEvent["type"]; ts: number } | null
}

export interface LegacyGaugeShadowSnapshot {
  version: 1
  sessionId: string
  goalMinutes: number | null
  state: GaugeState
  effectLog: GaugeShadowEffectRecord[]
  eventCount: number
  lastEvent: { type: GaugeEvent["type"]; ts: number } | null
}

export interface GaugeShadowStore {
  load(): Promise<unknown>
  reset(snapshot: GaugeShadowSnapshot): Promise<void>
  commit(
    snapshot: GaugeShadowSnapshot,
    effects: GaugeShadowEffectRecord[],
  ): Promise<void>
  clear(): Promise<void>
}

/**
 * Serializes reducer transitions around an IndexedDB-backed store. The store
 * commits the state checkpoint and newly emitted effects in one transaction.
 * Memory is updated only after that transaction succeeds, so it is a cache and
 * never the source of truth. Effect delivery remains deliberately absent.
 */
export class GaugeShadowController {
  private readonly storage: GaugeShadowStore
  private tail: Promise<void> = Promise.resolve()
  private loaded = false
  private current: GaugeShadowSnapshot | null = null

  constructor(storage: GaugeShadowStore) {
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
        const next: GaugeShadowSnapshot = {
          version: 2,
          sessionId,
          goalMinutes: normalizeGoalMinutes(goalMinutes),
          state: { ...state, updatedAt: ts },
          effectLog: [],
          outboxCount: 0,
          eventCount: 0,
          lastEvent: null,
        }
        await this.storage.reset(next)
        this.current = next
      }
      if (!this.current) throw new Error("Gauge shadow session was not initialized")
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
      const recorded: GaugeShadowEffectRecord[] = transition.effects.map((effect) => ({
        ts: event.ts,
        sourceEvent: event.type,
        effect,
      }))
      const next: GaugeShadowSnapshot = {
        ...this.current,
        state: transition.state,
        effectLog: [...this.current.effectLog, ...recorded].slice(-GAUGE_SHADOW_MAX_EFFECTS),
        outboxCount: this.current.outboxCount + recorded.length,
        eventCount: this.current.eventCount + 1,
        lastEvent: { type: event.type, ts: event.ts },
      }
      await this.storage.commit(next, recorded)
      this.current = next
      return next
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
      await this.storage.clear()
      this.loaded = true
      this.current = null
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
    this.current = parseGaugeShadowSnapshot(stored)
    this.loaded = true
  }
}

export function parseGaugeShadowSnapshot(value: unknown): GaugeShadowSnapshot | null {
  if (!isSnapshotBase(value)) return null
  const snapshot = value as Partial<GaugeShadowSnapshot>
  if (
    snapshot.version !== 2
    || !Number.isInteger(snapshot.outboxCount)
    || (snapshot.outboxCount ?? -1) < 0
  ) return null
  return snapshot as GaugeShadowSnapshot
}

export function parseLegacyGaugeShadowSnapshot(
  value: unknown,
): LegacyGaugeShadowSnapshot | null {
  if (!isSnapshotBase(value)) return null
  const snapshot = value as Partial<LegacyGaugeShadowSnapshot>
  return snapshot.version === 1 ? snapshot as LegacyGaugeShadowSnapshot : null
}

function normalizeGoalMinutes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  return value
}

function isSnapshotBase(
  value: unknown,
): value is GaugeShadowSnapshot | LegacyGaugeShadowSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Partial<GaugeShadowSnapshot | LegacyGaugeShadowSnapshot>
  return (
    typeof snapshot.sessionId === "string"
    && snapshot.sessionId.length > 0
    && (
      snapshot.goalMinutes === null
      || (
        typeof snapshot.goalMinutes === "number"
        && Number.isFinite(snapshot.goalMinutes)
        && snapshot.goalMinutes > 0
      )
    )
    && isGaugeState(snapshot.state)
    && Array.isArray(snapshot.effectLog)
    && snapshot.effectLog.every(isGaugeEffectRecord)
    && Number.isInteger(snapshot.eventCount)
    && (snapshot.eventCount ?? -1) >= 0
    && isLastEvent(snapshot.lastEvent)
  )
}

function isGaugeState(value: unknown): value is GaugeState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<GaugeState>
  return (
    isFiniteNumber(state.s)
    && isFiniteNumber(state.m)
    && isFiniteNumber(state.accelTier)
    && isFiniteNumber(state.updatedAt)
    && (state.activePageKey === null || typeof state.activePageKey === "string")
    && (
      state.activeVerdict === null
      || state.activeVerdict === "OK"
      || state.activeVerdict === "DRIFT"
    )
    && typeof state.degraded === "boolean"
    && isNullableFiniteNumber(state.activeMargin)
    && (state.pendingTier2 === null || typeof state.pendingTier2 === "object")
    && (state.lastJudgment === null || typeof state.lastJudgment === "object")
    && isFiniteNumber(state.nagN)
    && isFiniteNumber(state.renagDebt)
    && isNullableFiniteNumber(state.lastNagTs)
    && typeof state.celebrateArmed === "boolean"
    && isNullableFiniteNumber(state.snoozedUntil)
  )
}

function isGaugeEffectRecord(value: unknown): value is GaugeShadowEffectRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<GaugeShadowEffectRecord>
  return (
    isFiniteNumber(record.ts)
    && isGaugeEventType(record.sourceEvent)
    && isGaugeEffect(record.effect)
  )
}

function isGaugeEffect(value: unknown): value is GaugeEffect {
  if (!value || typeof value !== "object") return false
  const effect = value as Partial<GaugeEffect>
  if (effect.type === "celebrate") return true
  if (effect.type === "nag") return typeof effect.pageKey === "string"
  return (
    effect.type === "request_tier2"
    && (effect.reason === "promotion" || effect.reason === "s_zero")
    && isFiniteNumber(effect.tier)
    && typeof effect.pageKey === "string"
  )
}

function isLastEvent(
  value: unknown,
): value is GaugeShadowSnapshot["lastEvent"] {
  if (value === null) return true
  if (!value || typeof value !== "object") return false
  const event = value as { type?: unknown; ts?: unknown }
  return isGaugeEventType(event.type) && isFiniteNumber(event.ts)
}

function isGaugeEventType(value: unknown): value is GaugeEvent["type"] {
  return (
    value === "nav"
    || value === "heartbeat"
    || value === "inactive"
    || value === "tier2_result"
    || value === "snooze"
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

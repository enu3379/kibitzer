import {
  GAUGE_SHADOW_MAX_EFFECTS,
  parseGaugeShadowSnapshot,
  parseLegacyGaugeShadowSnapshot,
} from "./gaugeShadow.ts"
import type {
  GaugeShadowEffectRecord,
  GaugeShadowSnapshot,
  GaugeShadowStore,
} from "./gaugeShadow.ts"

export const GAUGE_DATABASE_NAME = "kibitzer-gauge"
export const GAUGE_DATABASE_VERSION = 1

const STATE_STORE = "state"
const OUTBOX_STORE = "effect-outbox"
const CURRENT_STATE_KEY = "current"

interface GaugeCheckpoint {
  version: 2
  sessionId: string
  goalMinutes: number | null
  state: GaugeShadowSnapshot["state"]
  eventCount: number
  lastEvent: GaugeShadowSnapshot["lastEvent"]
}

interface StoredGaugeEffect extends GaugeShadowEffectRecord {
  id?: number
  sessionId: string
  eventNumber: number
  status: "pending"
  attempts: 0
}

interface GaugeIndexedDbOptions {
  databaseName?: string
  indexedDB?: IDBFactory
}

/**
 * Persistent gauge SSOT. Every reducer checkpoint and its newly emitted
 * effects are queued in one IndexedDB transaction. Phase 3 never consumes the
 * outbox; later cutover phases may deliver and acknowledge these entries.
 */
export class GaugeIndexedDbStore implements GaugeShadowStore {
  private readonly databaseName: string
  private readonly factory: IDBFactory
  private databasePromise: Promise<IDBDatabase> | null = null

  constructor(options: GaugeIndexedDbOptions = {}) {
    this.databaseName = options.databaseName ?? GAUGE_DATABASE_NAME
    this.factory = options.indexedDB ?? globalThis.indexedDB
    if (!this.factory) throw new Error("IndexedDB is unavailable")
  }

  async load(): Promise<GaugeShadowSnapshot | null> {
    const database = await this.open()
    const transaction = database.transaction([STATE_STORE, OUTBOX_STORE], "readonly")
    const completed = transactionDone(transaction)
    const checkpointRequest = transaction.objectStore(STATE_STORE).get(CURRENT_STATE_KEY)
    const effectsRequest = transaction.objectStore(OUTBOX_STORE).getAll()
    const [checkpoint, allEffects] = await Promise.all([
      requestResult(checkpointRequest),
      requestResult(effectsRequest) as Promise<StoredGaugeEffect[]>,
    ])
    await completed

    if (!isGaugeCheckpoint(checkpoint)) return null
    const effects = allEffects
      .filter((entry) => entry.sessionId === checkpoint.sessionId)
      .sort((left, right) => (left.id ?? 0) - (right.id ?? 0))
    return parseGaugeShadowSnapshot({
      ...checkpoint,
      effectLog: effects.slice(-GAUGE_SHADOW_MAX_EFFECTS).map(toEffectRecord),
      outboxCount: effects.length,
    })
  }

  async reset(snapshot: GaugeShadowSnapshot): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction([STATE_STORE, OUTBOX_STORE], "readwrite")
    const completed = transactionDone(transaction)
    try {
      transaction.objectStore(OUTBOX_STORE).clear()
      transaction.objectStore(STATE_STORE).put(toCheckpoint(snapshot), CURRENT_STATE_KEY)
    } catch (error) {
      transaction.abort()
      await completed.catch(() => undefined)
      throw error
    }
    await completed
  }

  async commit(
    snapshot: GaugeShadowSnapshot,
    effects: GaugeShadowEffectRecord[],
  ): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction([STATE_STORE, OUTBOX_STORE], "readwrite")
    const completed = transactionDone(transaction)
    try {
      transaction.objectStore(STATE_STORE).put(toCheckpoint(snapshot), CURRENT_STATE_KEY)
      const outbox = transaction.objectStore(OUTBOX_STORE)
      for (const effect of effects) {
        outbox.add({
          ...effect,
          sessionId: snapshot.sessionId,
          eventNumber: snapshot.eventCount,
          status: "pending",
          attempts: 0,
        } satisfies StoredGaugeEffect)
      }
    } catch (error) {
      transaction.abort()
      await completed.catch(() => undefined)
      throw error
    }
    await completed
  }

  async clear(): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction([STATE_STORE, OUTBOX_STORE], "readwrite")
    const completed = transactionDone(transaction)
    transaction.objectStore(STATE_STORE).clear()
    transaction.objectStore(OUTBOX_STORE).clear()
    await completed
  }

  async importLegacy(value: unknown): Promise<boolean> {
    const legacy = parseLegacyGaugeShadowSnapshot(value)
    if (!legacy) return false

    const database = await this.open()
    const transaction = database.transaction([STATE_STORE, OUTBOX_STORE], "readwrite")
    const completed = transactionDone(transaction)
    const stateStore = transaction.objectStore(STATE_STORE)
    const existing = await requestResult(stateStore.get(CURRENT_STATE_KEY))
    if (existing !== undefined) {
      await completed
      return false
    }

    const snapshot: GaugeShadowSnapshot = {
      ...legacy,
      version: 2,
      outboxCount: legacy.effectLog.length,
    }
    try {
      stateStore.put(toCheckpoint(snapshot), CURRENT_STATE_KEY)
      const outbox = transaction.objectStore(OUTBOX_STORE)
      for (const effect of legacy.effectLog) {
        outbox.add({
          ...effect,
          sessionId: legacy.sessionId,
          eventNumber: legacy.eventCount,
          status: "pending",
          attempts: 0,
        } satisfies StoredGaugeEffect)
      }
    } catch (error) {
      transaction.abort()
      await completed.catch(() => undefined)
      throw error
    }
    await completed
    return true
  }

  async close(): Promise<void> {
    if (!this.databasePromise) return
    const databasePromise = this.databasePromise
    this.databasePromise = null
    const database = await databasePromise
    database.close()
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, GAUGE_DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STATE_STORE)) {
          database.createObjectStore(STATE_STORE)
        }
        if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
          const outbox = database.createObjectStore(OUTBOX_STORE, {
            keyPath: "id",
            autoIncrement: true,
          })
          outbox.createIndex("sessionId", "sessionId", { unique: false })
        }
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => {
          database.close()
          this.databasePromise = null
        }
        database.onclose = () => {
          this.databasePromise = null
        }
        resolve(database)
      }
      request.onerror = () => {
        this.databasePromise = null
        reject(request.error ?? new Error("Failed to open gauge IndexedDB"))
      }
    })
    return this.databasePromise
  }
}

function toCheckpoint(snapshot: GaugeShadowSnapshot): GaugeCheckpoint {
  return {
    version: 2,
    sessionId: snapshot.sessionId,
    goalMinutes: snapshot.goalMinutes,
    state: snapshot.state,
    eventCount: snapshot.eventCount,
    lastEvent: snapshot.lastEvent,
  }
}

function toEffectRecord(effect: StoredGaugeEffect): GaugeShadowEffectRecord {
  return {
    ts: effect.ts,
    sourceEvent: effect.sourceEvent,
    effect: effect.effect,
  }
}

function isGaugeCheckpoint(value: unknown): value is GaugeCheckpoint {
  if (!value || typeof value !== "object") return false
  const checkpoint = value as Partial<GaugeCheckpoint>
  return Boolean(
    parseGaugeShadowSnapshot({
      ...checkpoint,
      effectLog: [],
      outboxCount: 0,
    }),
  )
}

function requestResult<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction aborted"),
    )
    transaction.onerror = () => {
      // The abort event carries the final transaction error.
    }
  })
}

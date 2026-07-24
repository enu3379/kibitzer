import assert from "node:assert/strict"
import test from "node:test"

import { IDBFactory } from "fake-indexeddb"

import { initGaugeState } from "../core/gauge/types.ts"
import { GaugeIndexedDbStore } from "./gaugeIndexedDb.ts"
import { GaugeShadowController } from "./gaugeShadow.ts"
import type {
  GaugeShadowEffectRecord,
  GaugeShadowSnapshot,
  LegacyGaugeShadowSnapshot,
} from "./gaugeShadow.ts"

let databaseSequence = 0

function createStore(): {
  factory: IDBFactory
  name: string
  store: GaugeIndexedDbStore
} {
  const factory = new IDBFactory()
  const name = `gauge-test-${databaseSequence += 1}`
  return {
    factory,
    name,
    store: new GaugeIndexedDbStore({ indexedDB: factory, databaseName: name }),
  }
}

function initialSnapshot(): GaugeShadowSnapshot {
  return {
    version: 2,
    sessionId: "session-1",
    goalMinutes: null,
    state: initGaugeState(),
    effectLog: [],
    outboxCount: 0,
    eventCount: 0,
    lastEvent: null,
  }
}

async function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Database ${name} is still open`))
  })
}

test("IndexedDB restores the checkpoint and pending outbox across worker restarts", async () => {
  const { factory, name, store } = createStore()
  const first = new GaugeShadowController(store)
  await first.ensureSession("session-1", null, 0)
  await first.dispatch({
    type: "nav",
    pageKey: "example.test:path",
    verdict: "DRIFT",
    ts: 0,
  })
  for (let index = 1; index <= 4; index += 1) {
    await first.dispatch({ type: "heartbeat", ts: index * 90_000 })
  }
  const beforeRestart = await first.snapshot()
  assert.ok(beforeRestart)
  assert.ok(beforeRestart.outboxCount > 0)
  assert.equal(beforeRestart.effectLog.length, beforeRestart.outboxCount)
  await store.close()

  const reopenedStore = new GaugeIndexedDbStore({
    indexedDB: factory,
    databaseName: name,
  })
  const restarted = new GaugeShadowController(reopenedStore)
  const restored = await restarted.snapshot("session-1")
  assert.deepEqual(restored, beforeRestart)

  await reopenedStore.close()
  await deleteDatabase(factory, name)
})

test("state and effects roll back together when an outbox write cannot clone", async () => {
  const { factory, name, store } = createStore()
  const initial = initialSnapshot()
  await store.reset(initial)

  const next: GaugeShadowSnapshot = {
    ...initial,
    state: { ...initial.state, s: 50, updatedAt: 90_000 },
    outboxCount: 1,
    eventCount: 1,
    lastEvent: { type: "heartbeat", ts: 90_000 },
  }
  const invalidEffects = [{
    ts: 90_000,
    sourceEvent: "heartbeat",
    effect: {
      type: "nag",
      pageKey: (() => "not cloneable") as unknown as string,
    },
  }] satisfies GaugeShadowEffectRecord[]

  await assert.rejects(store.commit(next, invalidEffects))
  assert.deepEqual(await store.load(), initial)

  await store.close()
  await deleteDatabase(factory, name)
})

test("legacy chrome.storage.session state imports once into the IndexedDB outbox", async () => {
  const { factory, name, store } = createStore()
  const legacy: LegacyGaugeShadowSnapshot = {
    version: 1,
    sessionId: "legacy-session",
    goalMinutes: 120,
    state: { ...initGaugeState(), s: 73, updatedAt: 90_000 },
    effectLog: [{
      ts: 90_000,
      sourceEvent: "heartbeat",
      effect: {
        type: "request_tier2",
        reason: "promotion",
        tier: 0,
        pageKey: "example.test:path",
      },
    }],
    eventCount: 4,
    lastEvent: { type: "heartbeat", ts: 90_000 },
  }

  assert.equal(await store.importLegacy(legacy), true)
  assert.equal(await store.importLegacy(legacy), false)
  const imported = await store.load()
  assert.ok(imported)
  assert.equal(imported.version, 2)
  assert.equal(imported.sessionId, "legacy-session")
  assert.equal(imported.state.s, 73)
  assert.equal(imported.outboxCount, 1)
  assert.deepEqual(imported.effectLog, legacy.effectLog)

  await store.close()
  await deleteDatabase(factory, name)
})

test("the outbox retains all effects while diagnostics expose only the latest 50", async () => {
  const { factory, name, store } = createStore()
  const initial = initialSnapshot()
  await store.reset(initial)
  const effects = Array.from({ length: 55 }, (_, index) => ({
    ts: index,
    sourceEvent: "heartbeat" as const,
    effect: { type: "celebrate" as const },
  }))
  await store.commit(
    { ...initial, outboxCount: effects.length, eventCount: 1 },
    effects,
  )

  const loaded = await store.load()
  assert.ok(loaded)
  assert.equal(loaded.outboxCount, 55)
  assert.equal(loaded.effectLog.length, 50)
  assert.equal(loaded.effectLog[0]?.ts, 5)
  assert.equal(loaded.effectLog.at(-1)?.ts, 54)

  await store.close()
  await deleteDatabase(factory, name)
})

test("reset and clear remove the previous session outbox", async () => {
  const { factory, name, store } = createStore()
  const initial = initialSnapshot()
  await store.reset(initial)
  await store.commit(
    { ...initial, outboxCount: 1, eventCount: 1 },
    [{
      ts: 1,
      sourceEvent: "heartbeat",
      effect: { type: "celebrate" },
    }],
  )

  const replacement: GaugeShadowSnapshot = {
    ...initial,
    sessionId: "session-2",
    state: { ...initial.state, updatedAt: 2 },
  }
  await store.reset(replacement)
  assert.deepEqual(await store.load(), replacement)

  await store.clear()
  assert.equal(await store.load(), null)

  await store.close()
  await deleteDatabase(factory, name)
})

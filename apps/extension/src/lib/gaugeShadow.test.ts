import assert from "node:assert/strict"
import test from "node:test"

import {
  GAUGE_SHADOW_MAX_EFFECTS,
  GaugeShadowController,
} from "./gaugeShadow.ts"
import type { GaugeShadowSnapshot, GaugeShadowStorage } from "./gaugeShadow.ts"

class MemoryStorage implements GaugeShadowStorage {
  value: GaugeShadowSnapshot | null = null

  async load(): Promise<unknown> {
    return structuredClone(this.value)
  }

  async save(snapshot: GaugeShadowSnapshot): Promise<void> {
    this.value = structuredClone(snapshot)
  }

  async clear(): Promise<void> {
    this.value = null
  }
}

test("gauge shadow persists a session across controller restarts", async () => {
  const storage = new MemoryStorage()
  const first = new GaugeShadowController(storage)
  await first.ensureSession("session-1", 120, 1_000)
  await first.dispatch({
    type: "nav",
    pageKey: "example.test:path",
    verdict: "DRIFT",
    ts: 1_000,
  })
  const afterHeartbeat = await first.dispatch({ type: "heartbeat", ts: 61_000 })

  assert.ok(afterHeartbeat)
  assert.equal(afterHeartbeat.sessionId, "session-1")
  assert.equal(afterHeartbeat.eventCount, 2)
  assert.ok(afterHeartbeat.state.s < 100)

  const restarted = new GaugeShadowController(storage)
  const restored = await restarted.snapshot("session-1")
  assert.deepEqual(restored, afterHeartbeat)

  const continued = await restarted.dispatch({ type: "heartbeat", ts: 121_000 })
  assert.ok(continued)
  assert.ok(continued.state.s < afterHeartbeat.state.s)
})

test("goal replacement resets state even within the same server session", async () => {
  const storage = new MemoryStorage()
  const shadow = new GaugeShadowController(storage)
  await shadow.ensureSession("session-1", 60, 1_000)
  await shadow.dispatch({
    type: "nav",
    pageKey: "example.test:path",
    verdict: "DRIFT",
    ts: 1_000,
  })
  await shadow.dispatch({ type: "heartbeat", ts: 91_000 })

  const reset = await shadow.ensureSession("session-1", 240, 100_000, true)
  assert.equal(reset.goalMinutes, 240)
  assert.equal(reset.state.s, 100)
  assert.equal(reset.state.updatedAt, 100_000)
  assert.equal(reset.eventCount, 0)
  assert.deepEqual(reset.effectLog, [])
})

test("inactive and resume rebases keep wall-clock gaps out of the gauge", async () => {
  const storage = new MemoryStorage()
  const shadow = new GaugeShadowController(storage)
  await shadow.ensureSession("session-1", null, 0)
  await shadow.dispatch({
    type: "nav",
    pageKey: "example.test:path",
    verdict: "DRIFT",
    ts: 0,
  })
  await shadow.dispatch({ type: "heartbeat", ts: 30_000 })
  const beforeInactive = await shadow.snapshot()
  assert.ok(beforeInactive)

  await shadow.dispatch({ type: "inactive", ts: 30_000 })
  await shadow.dispatch({ type: "inactive", ts: 10 * 60_000 })
  const resumed = await shadow.dispatch({ type: "heartbeat", ts: 10 * 60_000 + 30_000 })

  assert.ok(resumed)
  const activeWindowDrain = beforeInactive.state.s - resumed.state.s
  assert.ok(activeWindowDrain > 0)
  assert.ok(activeWindowDrain < 4)
})

test("reducer effects are recorded and bounded but never delivered", async () => {
  const storage = new MemoryStorage()
  const shadow = new GaugeShadowController(storage)
  await shadow.ensureSession("session-1", null, 0)
  await shadow.dispatch({
    type: "nav",
    pageKey: "example.test:path",
    verdict: "DRIFT",
    ts: 0,
  })

  for (let index = 1; index <= 4; index += 1) {
    await shadow.dispatch({ type: "heartbeat", ts: index * 90_000 })
  }
  const promoted = await shadow.snapshot()
  assert.ok(promoted)
  assert.ok(promoted.effectLog.some((item) => item.effect.type === "request_tier2"))

  storage.value = {
    ...promoted,
    effectLog: Array.from({ length: GAUGE_SHADOW_MAX_EFFECTS }, (_, index) => ({
      ts: index,
      sourceEvent: "heartbeat" as const,
      effect: { type: "celebrate" as const },
    })),
  }
  const reloaded = new GaugeShadowController(storage)
  await reloaded.dispatch({ type: "heartbeat", ts: 450_000 })
  assert.equal(storage.value?.effectLog.length, GAUGE_SHADOW_MAX_EFFECTS)
})

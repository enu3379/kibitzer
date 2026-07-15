import assert from "node:assert/strict"
import test from "node:test"

import {
  D7ReviewScheduler,
  d7ReviewAlarmName,
} from "../src/lib/d7ReviewScheduler.ts"
import { createChromeMock } from "./helpers/chrome.mjs"
import { installFakeClock } from "./helpers/fakeClock.mjs"

test("a long review check survives a service-worker restart as a one-shot alarm", async () => {
  const clock = installFakeClock(1_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const observationId = "obs/with spaces"
  try {
    const firstWorker = new D7ReviewScheduler(async () => {})
    await firstWorker.schedule(observationId, 60)
    assert.equal(clock.pendingCount(), 0)
    assert.equal(
      (await harness.chrome.alarms.get(d7ReviewAlarmName(observationId))).scheduledTime,
      61_000,
    )

    const handled = []
    const restartedWorker = new D7ReviewScheduler(async (id) => handled.push(id))
    harness.chrome.alarms.onAlarm.addListener((alarm) => restartedWorker.handleAlarm(alarm.name))
    await clock.advanceTo(61_000)
    await harness.alarms.fireDue(clock.now())

    assert.deepEqual(handled, [observationId])
    assert.equal(await harness.chrome.alarms.get(d7ReviewAlarmName(observationId)), undefined)
  } finally {
    clock.restore()
  }
})

test("a short review check uses a timer and clears its backup alarm", async () => {
  const clock = installFakeClock(1_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const handled = []
  try {
    const scheduler = new D7ReviewScheduler(async (id) => handled.push(id))
    await scheduler.schedule("obs-short", 10)
    assert.equal(clock.pendingCount(), 1)

    await clock.advanceTo(11_000)

    assert.deepEqual(handled, ["obs-short"])
    assert.equal(await harness.chrome.alarms.get(d7ReviewAlarmName("obs-short")), undefined)
  } finally {
    clock.restore()
  }
})

test("rescheduling an observation replaces its earlier review check", async () => {
  const clock = installFakeClock(1_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const handled = []
  try {
    const scheduler = new D7ReviewScheduler(async (id) => handled.push(id))
    await scheduler.schedule("obs-rescheduled", 10)
    await scheduler.schedule("obs-rescheduled", 20)
    await clock.advanceTo(11_000)
    assert.deepEqual(handled, [])
    await clock.advanceTo(21_000)
    assert.deepEqual(handled, ["obs-rescheduled"])
  } finally {
    clock.restore()
  }
})

test("overlapping reschedules serialize clear and replacement", async () => {
  const clock = installFakeClock(1_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const handled = []
  const originalClear = harness.chrome.alarms.clear.bind(harness.chrome.alarms)
  let releaseFirstClear
  let signalFirstClear
  const firstClearStarted = new Promise((resolve) => { signalFirstClear = resolve })
  const firstClearGate = new Promise((resolve) => { releaseFirstClear = resolve })
  let clearCalls = 0
  harness.chrome.alarms.clear = async (name) => {
    clearCalls += 1
    if (clearCalls === 1) {
      signalFirstClear()
      await firstClearGate
    }
    return originalClear(name)
  }

  try {
    const scheduler = new D7ReviewScheduler(async (id) => handled.push(id))
    const first = scheduler.schedule("obs-overlap", 10)
    await firstClearStarted
    const second = scheduler.schedule("obs-overlap", 20)
    releaseFirstClear()
    await Promise.all([first, second])

    await clock.advanceTo(11_000)
    assert.deepEqual(handled, [])
    await clock.advanceTo(21_000)
    assert.deepEqual(handled, ["obs-overlap"])
  } finally {
    clock.restore()
  }
})

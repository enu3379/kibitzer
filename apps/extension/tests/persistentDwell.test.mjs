import assert from "node:assert/strict"
import test from "node:test"

import {
  DWELL_RECORD_VERSION,
  PersistentDwellScheduler,
  recordKey,
} from "../src/lib/persistentDwell.ts"
import { createChromeMock } from "./helpers/chrome.mjs"
import { installFakeClock } from "./helpers/fakeClock.mjs"

function observationRecord(overrides = {}) {
  return {
    version: DWELL_RECORD_VERSION,
    stage: "observation",
    token: "nav_observation",
    tabId: 7,
    url: "https://example.com/observe",
    dueAt: 61_000,
    historyId: "hist_observation",
    startedAt: 1_000,
    tier2DwellMs: 60_000,
    ...overrides,
  }
}

function tier2Record(overrides = {}) {
  return {
    version: DWELL_RECORD_VERSION,
    stage: "tier2",
    token: "nav_tier2",
    tabId: 7,
    url: "https://example.com/tier2",
    dueAt: 61_000,
    historyId: "hist_tier2",
    observationId: "obs_tier2",
    ...overrides,
  }
}

for (const [stage, makeRecord] of [
  ["observation", observationRecord],
  ["tier2", tier2Record],
]) {
  test(`restores a 60s ${stage} stage after worker restart`, async () => {
    const clock = installFakeClock(1_000)
    const harness = createChromeMock({ now: clock.now })
    globalThis.chrome = harness.chrome
    const record = makeRecord()
    try {
      const firstWorker = new PersistentDwellScheduler(async () => "complete", async () => {})
      await firstWorker.startNavigation(record.tabId, record.token)
      await firstWorker.schedule(record)
      assert.equal(clock.pendingCount(), 0, "long dwell must not depend on an in-memory timer")

      let handled = 0
      const restartedWorker = new PersistentDwellScheduler(
        async () => {
          handled += 1
          return "complete"
        },
        async () => {},
      )
      harness.chrome.alarms.onAlarm.addListener((alarm) => restartedWorker.handleAlarm(alarm.name))
      await restartedWorker.restore()
      await clock.advanceTo(record.dueAt)
      await harness.alarms.fireDue(clock.now())

      assert.equal(handled, 1)
      assert.equal(harness.storage.session.snapshot()[recordKey(record)], undefined)
      assert.equal(await harness.chrome.alarms.get(recordKey(record)), undefined)
    } finally {
      clock.restore()
    }
  })
}

test("navigation token change cancels stale persisted work", async () => {
  const clock = installFakeClock(1_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const cancelled = []
  try {
    const scheduler = new PersistentDwellScheduler(
      async () => "complete",
      async (record) => cancelled.push(record.token),
    )
    const stale = observationRecord()
    await scheduler.startNavigation(stale.tabId, stale.token)
    await scheduler.schedule(stale)
    await scheduler.startNavigation(stale.tabId, "nav_new")

    assert.deepEqual(cancelled, [stale.token])
    assert.equal(harness.storage.session.snapshot()[recordKey(stale)], undefined)
    assert.equal(await harness.chrome.alarms.get(recordKey(stale)), undefined)
  } finally {
    clock.restore()
  }
})

test("server success followed by response loss retries the same persisted stage", async () => {
  const clock = installFakeClock(61_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const record = observationRecord()
  let requests = 0
  let commits = 0
  let serverCommitted = false
  try {
    const scheduler = new PersistentDwellScheduler(
      async () => {
        requests += 1
        if (!serverCommitted) {
          serverCommitted = true
          commits += 1
          return "retry"
        }
        return "complete"
      },
      async () => {},
    )
    await scheduler.startNavigation(record.tabId, record.token)
    await scheduler.schedule(record)
    await scheduler.handleAlarm(recordKey(record))

    const retried = harness.storage.session.snapshot()[recordKey(record)]
    assert.equal(retried.token, record.token)
    assert.equal(retried.dueAt, record.dueAt + 5_000)

    await clock.advanceTo(retried.dueAt)
    assert.equal(requests, 2)
    assert.equal(commits, 1)
    assert.equal(harness.storage.session.snapshot()[recordKey(record)], undefined)
  } finally {
    clock.restore()
  }
})

test("duplicate alarm delivery runs one in-flight handler", async () => {
  const clock = installFakeClock(61_000)
  const harness = createChromeMock({ now: clock.now })
  globalThis.chrome = harness.chrome
  const record = tier2Record()
  let requests = 0
  let commits = 0
  let committed = false
  try {
    const scheduler = new PersistentDwellScheduler(
      async () => {
        requests += 1
        if (!committed) {
          committed = true
          commits += 1
        }
        return "complete"
      },
      async () => {},
    )
    await scheduler.startNavigation(record.tabId, record.token)
    await scheduler.schedule(record)
    await Promise.all([
      scheduler.handleAlarm(recordKey(record)),
      scheduler.handleAlarm(recordKey(record)),
    ])

    assert.equal(requests, 1)
    assert.equal(commits, 1)
    assert.equal(harness.storage.session.snapshot()[recordKey(record)], undefined)
  } finally {
    clock.restore()
  }
})

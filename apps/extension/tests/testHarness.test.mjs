import assert from "node:assert/strict"
import test from "node:test"

import { createChromeMock } from "./helpers/chrome.mjs"
import { installFakeClock } from "./helpers/fakeClock.mjs"

test("storage doubles clone values, emit changes, and support one-shot failures", async () => {
  const harness = createChromeMock({ session: { count: 1 } })
  const changes = []
  harness.chrome.storage.onChanged.addListener((change, area) => changes.push({ change, area }))

  const loaded = await harness.chrome.storage.session.get("count")
  loaded.count = 999
  assert.deepEqual(harness.storage.session.snapshot(), { count: 1 })

  await harness.chrome.storage.session.set({ count: 2 })
  assert.deepEqual(harness.storage.session.snapshot(), { count: 2 })
  assert.deepEqual(changes, [
    {
      area: "session",
      change: { count: { oldValue: 1, newValue: 2 } },
    },
  ])

  harness.storage.session.failNext("get")
  await assert.rejects(harness.chrome.storage.session.get("count"), /synthetic get failure/)
  assert.deepEqual(await harness.chrome.storage.session.get("count"), { count: 2 })
})

test("tabs doubles support query, activation, update, removal, and failures", async () => {
  const harness = createChromeMock({
    tabs: [
      { id: 1, active: true, url: "https://one.example", windowId: 1 },
      { id: 2, active: false, url: "https://two.example", windowId: 1 },
      { id: 3, active: true, url: "https://other-window.example", windowId: 2 },
    ],
  })
  const activated = []
  const removed = []
  harness.chrome.tabs.onActivated.addListener((info) => activated.push(info))
  harness.chrome.tabs.onRemoved.addListener((tabId) => removed.push(tabId))

  assert.deepEqual(
    (await harness.chrome.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.id),
    [1],
  )
  await harness.tabs.activate(2)
  await harness.tabs.update(2, { title: "Two" })
  assert.deepEqual(activated, [{ tabId: 2, windowId: 1 }])
  assert.deepEqual(
    (await harness.chrome.tabs.query({ active: true })).map((tab) => tab.id),
    [2, 3],
  )
  assert.equal((await harness.chrome.tabs.get(2)).title, "Two")

  harness.tabs.failNextGet()
  await assert.rejects(harness.chrome.tabs.get(2), /synthetic tabs.get failure/)
  assert.equal(await harness.tabs.remove(2), true)
  assert.deepEqual(removed, [2])
})

test("alarms double stores schedules and emits one-shot and periodic alarms", async () => {
  const harness = createChromeMock({ now: () => 1_000 })
  const fired = []
  harness.chrome.alarms.onAlarm.addListener((alarm) => fired.push(alarm))

  await harness.chrome.alarms.create("once", { delayInMinutes: 1 })
  await harness.chrome.alarms.create("periodic", { periodInMinutes: 2 })
  assert.equal((await harness.chrome.alarms.get("once")).scheduledTime, 61_000)

  assert.equal(await harness.alarms.fire("once"), true)
  assert.equal(await harness.chrome.alarms.get("once"), undefined)
  assert.equal(await harness.alarms.fire("periodic"), true)
  assert.equal((await harness.chrome.alarms.get("periodic")).scheduledTime, 241_000)
  assert.deepEqual(fired.map((alarm) => alarm.name), ["once", "periodic"])
  assert.deepEqual(fired.map((alarm) => alarm.scheduledTime), [61_000, 121_000])
})

test("fake clock advances timers deterministically and restores globals", async () => {
  const realSetTimeout = globalThis.setTimeout
  const clock = installFakeClock(5_000)
  const calls = []
  try {
    const cancelled = setTimeout(() => calls.push("cancelled"), 10)
    clearTimeout(cancelled)
    setTimeout(() => {
      calls.push(`first:${Date.now()}`)
      setTimeout(() => calls.push(`nested:${Date.now()}`), 5)
    }, 20)

    await clock.advanceBy(19)
    assert.deepEqual(calls, [])
    await clock.advanceBy(1)
    assert.deepEqual(calls, ["first:5020"])
    await clock.runAll()
    assert.deepEqual(calls, ["first:5020", "nested:5025"])
    assert.equal(clock.pendingCount(), 0)
  } finally {
    clock.restore()
  }
  assert.equal(globalThis.setTimeout, realSetTimeout)
})

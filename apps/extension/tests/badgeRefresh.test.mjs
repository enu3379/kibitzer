import assert from "node:assert/strict"
import test from "node:test"

import { createBadgeRefresher } from "../src/lib/badgeRefresh.ts"

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test("drops a slow stale status after a newer refresh finishes", async () => {
  const olderStatus = deferred()
  const latestStatus = deferred()
  const statuses = [olderStatus.promise, latestStatus.promise]
  const applied = []
  const refresh = createBadgeRefresher(
    async () => statuses.shift(),
    async (status) => applied.push(status),
  )

  const olderRefresh = refresh()
  const latestRefresh = refresh()
  latestStatus.resolve("tracking")
  await latestRefresh
  olderStatus.resolve("pending")
  await olderRefresh

  assert.deepEqual(applied, ["tracking"])
})

test("reapplies the latest status after an older fallback finishes", async () => {
  const statuses = ["tracking", "pending", "tracking"]
  const fallbackStarted = deferred()
  const finishFallback = deferred()
  const applied = []
  const refresh = createBadgeRefresher(
    async () => statuses.shift(),
    async (status) => {
      if (status === "pending") {
        applied.push("draw:pending")
        fallbackStarted.resolve()
        await finishFallback.promise
        applied.push("fallback:pending")
        return
      }
      applied.push(`icon:${status}`)
    },
  )

  await refresh()
  const olderRefresh = refresh()
  await fallbackStarted.promise
  const latestRefresh = refresh()
  finishFallback.resolve()
  await Promise.all([olderRefresh, latestRefresh])

  assert.deepEqual(applied, [
    "icon:tracking",
    "draw:pending",
    "fallback:pending",
    "icon:tracking",
  ])
})

test("does not cache a failed status application", async () => {
  let attempts = 0
  const refresh = createBadgeRefresher(
    async () => "pending",
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error("synthetic icon failure")
    },
  )

  await assert.rejects(refresh(), /synthetic icon failure/)
  await refresh()

  assert.equal(attempts, 2)
})

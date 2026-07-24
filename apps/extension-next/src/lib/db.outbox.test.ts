// Integration test for the durable effect outbox (B1). Exercises real IndexedDB semantics
// via fake-indexeddb, not a stub — this is the atomic-write + at-least-once-drain contract
// the gauge relies on to never lose a nag/celebration across a service-worker teardown.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import {
  clearStore,
  drainRecords,
  getAllRecords,
  kvGet,
  kvPutAndAppend,
  OUTBOX_STORE,
} from "./db.ts"

interface OutboxRec {
  id: number
  effect: { type: string; pageKey?: string }
}

test("kvPutAndAppend commits the state checkpoint and its effects together, FIFO", async () => {
  await clearStore(OUTBOX_STORE)
  await kvPutAndAppend([{ key: "gauge-state", value: { s: 42 } }], OUTBOX_STORE, [
    { effect: { type: "nag", pageKey: "a" } },
    { effect: { type: "celebrate" } },
  ])

  assert.deepEqual(await kvGet("gauge-state"), { s: 42 })
  const recs = await getAllRecords<OutboxRec>(OUTBOX_STORE)
  assert.equal(recs.length, 2)
  assert.deepEqual(
    recs.map((r) => r.effect.type),
    ["nag", "celebrate"],
  )
  assert.ok(recs[0].id < recs[1].id, "delivered oldest-first by autoincrement id")
})

test("drainRecords delivers oldest-first and deletes only what was delivered", async () => {
  await clearStore(OUTBOX_STORE)
  await kvPutAndAppend([], OUTBOX_STORE, [
    { effect: { type: "nag", pageKey: "a" } },
    { effect: { type: "nag", pageKey: "b" } },
    { effect: { type: "nag", pageKey: "c" } },
  ])

  // Simulate a delivery failure mid-drain: "b" throws, so it must survive for a later drain
  // while "a" and "c" are delivered and removed.
  const delivered: string[] = []
  await drainRecords<OutboxRec>(OUTBOX_STORE, async (rec) => {
    if (rec.effect.pageKey === "b") throw new Error("teardown")
    delivered.push(rec.effect.pageKey ?? "")
  })

  assert.deepEqual(delivered, ["a", "c"])
  const left = await getAllRecords<OutboxRec>(OUTBOX_STORE)
  assert.deepEqual(
    left.map((r) => r.effect.pageKey),
    ["b"],
    "only the failed effect remains queued",
  )
})

test("a later drain redelivers what an interrupted one left (at-least-once)", async () => {
  await clearStore(OUTBOX_STORE)
  await kvPutAndAppend([], OUTBOX_STORE, [{ effect: { type: "nag", pageKey: "x" } }])

  let attempts = 0
  await drainRecords<OutboxRec>(OUTBOX_STORE, async () => {
    attempts += 1
    throw new Error("worker torn down before delivery")
  })
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 1, "survives the failed drain")

  await drainRecords<OutboxRec>(OUTBOX_STORE, async () => {
    attempts += 1
  })
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 0, "delivered and removed")
  assert.equal(attempts, 2)
})

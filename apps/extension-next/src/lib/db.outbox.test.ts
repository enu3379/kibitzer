// Integration test for the durable effect outbox (B1). Exercises real IndexedDB semantics
// via fake-indexeddb, not a stub — this is the atomic-write + ack/keep-drain + CAS-delete
// contract the gauge relies on to never lose a nag/celebration or double-run a Tier-2 job
// across a service-worker teardown.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import {
  clearStore,
  drainRecords,
  getAllRecords,
  kvDeleteIf,
  kvGet,
  kvPutAndAppend,
  kvSet,
  kvWriteAndClear,
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

test("drainRecords deletes only records the handler ACKs (true); false keeps them", async () => {
  await clearStore(OUTBOX_STORE)
  await kvPutAndAppend([], OUTBOX_STORE, [
    { effect: { type: "nag", pageKey: "a" } }, // ack → delete
    { effect: { type: "request_tier2", pageKey: "b" } }, // keep (owns its own lifetime)
    { effect: { type: "nag", pageKey: "c" } }, // ack → delete
  ])

  const seen: string[] = []
  await drainRecords<OutboxRec>(OUTBOX_STORE, async (rec) => {
    seen.push(rec.effect.pageKey ?? rec.effect.type)
    return rec.effect.type !== "request_tier2" // durable jobs are not ACKed by the drain
  })

  assert.deepEqual(seen, ["a", "b", "c"])
  const left = await getAllRecords<OutboxRec>(OUTBOX_STORE)
  assert.deepEqual(
    left.map((r) => r.effect.pageKey),
    ["b"],
    "the kept (unacked) record survives the drain",
  )
})

test("a throwing handler leaves its record; a later drain redelivers it (at-least-once)", async () => {
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
    return true
  })
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 0, "delivered and removed")
  assert.equal(attempts, 2)
})

test("kvWriteAndClear resets state, drops keys, and clears the outbox atomically", async () => {
  await clearStore(OUTBOX_STORE)
  await kvSet("gauge-state", { s: 10 })
  await kvSet("pending-writer", { pageKey: "x", message: "hi" })
  await kvPutAndAppend([], OUTBOX_STORE, [{ effect: { type: "nag", pageKey: "x" } }])

  await kvWriteAndClear([{ key: "gauge-state", value: { s: 100 } }], ["pending-writer"], [OUTBOX_STORE])

  assert.deepEqual(await kvGet("gauge-state"), { s: 100 }, "state reset")
  assert.equal(await kvGet("pending-writer"), undefined, "writer dropped")
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 0, "outbox cleared")
})

test("kvDeleteIf deletes only when the current value still matches (CAS)", async () => {
  await kvSet("pending-dwell", { obsKey: "A", dueAt: 100 })
  // A stale deleter that read version A must NOT delete once it has been replaced by B.
  await kvSet("pending-dwell", { obsKey: "B", dueAt: 200 })
  await kvDeleteIf("pending-dwell", (v) => (v as { obsKey: string }).obsKey === "A")
  assert.deepEqual(await kvGet("pending-dwell"), { obsKey: "B", dueAt: 200 }, "newer value untouched")

  // The matching deleter removes it.
  await kvDeleteIf("pending-dwell", (v) => (v as { obsKey: string }).obsKey === "B")
  assert.equal(await kvGet("pending-dwell"), undefined, "matched value deleted")
})

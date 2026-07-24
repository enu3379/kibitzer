// The v3 migration must SURGICALLY release a Tier-2 request wedged in pendingTier2 by
// pre-closure code (early-ACK, no serviceable outbox record) — without discarding the user's
// gauge progress. Own file → isolated fresh IndexedDB.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import { getAllRecords, kvGet, OUTBOX_STORE } from "./db.ts"

// Build a v2 "kibitzer" DB by hand and plant a HEALTHY session that also has a wedged
// pendingTier2, an incompatible legacy outbox record, and a staged Writer message.
function seedLegacyV2(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("kibitzer", 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv")
      for (const name of ["observations", "events", "outbox"]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id", autoIncrement: true })
          store.createIndex("ts", "ts", { unique: false })
        }
      }
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(["kv", "outbox"], "readwrite")
      tx.objectStore("kv").put(
        { s: 40, m: 0.3, accelTier: 1, pendingTier2: { reason: "s_zero", pageKey: "site/a", requestedAt: 1 } },
        "gauge-state",
      )
      tx.objectStore("kv").put({ pageKey: "site/a", message: "stale" }, "pending-writer")
      tx.objectStore("outbox").add({ effect: { type: "nag", pageKey: "x" }, ts: 1 })
      tx.oncomplete = () => {
        db.close() // release so db.ts can perform the v3 upgrade
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

test("v3 upgrade releases the wedge but preserves the healthy gauge session", async () => {
  await seedLegacyV2()
  // The first db.ts call opens at v3 → onupgradeneeded runs the surgical migration.
  const state = await kvGet<Record<string, unknown>>("gauge-state")
  assert.equal(state?.s, 40, "gauge progress preserved")
  assert.equal(state?.m, 0.3, "inertia preserved")
  assert.equal(state?.pendingTier2, null, "wedge released")
  assert.equal(state?.tier2ReqSeq, 0, "counter made numeric (no NaN on next request)")
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 0, "incompatible legacy outbox cleared")
  assert.equal(await kvGet("pending-writer"), undefined, "staged Writer text dropped")
})

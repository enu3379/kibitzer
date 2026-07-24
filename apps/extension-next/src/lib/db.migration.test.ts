// The v3 migration must wipe legacy runtime state + queued effects, so a Tier-2 request
// wedged in pendingTier2 by pre-closure code (early-ACK, no serviceable outbox record) can't
// survive the upgrade and stall the gauge forever. Own file → isolated fresh IndexedDB.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import { getAllRecords, kvGet, OUTBOX_STORE } from "./db.ts"

// Build a v2 "kibitzer" DB by hand and plant a wedged pendingTier2 + a queued effect.
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
        { s: 40, pendingTier2: { reason: "s_zero", pageKey: "site/a", requestedAt: 1 } },
        "gauge-state",
      )
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

test("v3 upgrade clears a legacy wedged pendingTier2 and queued effects", async () => {
  await seedLegacyV2()
  // The first db.ts call opens at v3 → onupgradeneeded runs the migration.
  assert.equal(await kvGet("gauge-state"), undefined, "legacy runtime state cleared")
  assert.equal((await getAllRecords(OUTBOX_STORE)).length, 0, "legacy queued effects cleared")
})

// Durable local store (IndexedDB) — the serverless SSOT. Unlike chrome.storage.session
// (in-memory, wiped on browser restart) this survives restarts, so the immersion gauge,
// drift timing, and recent-visit context carry over. Available in the MV3 service worker
// via globalThis.indexedDB.
//
// Stores:
//   kv           — small live state, keyed by name (gauge checkpoint, drift-since, …)
//   observations — durable per-page observation log (P3: analytics / exemplar learning)
//   events       — structured, append-only event log (P2-2)
//   outbox       — durable pending gauge effects (nag/celebrate/request_tier2). Written
//                  atomically with the gauge checkpoint so an effect is never lost when
//                  the service worker is torn down between state save and delivery.

const DB_NAME = "kibitzer"
const DB_VERSION = 2
const KV_STORE = "kv"
export const OBS_STORE = "observations"
export const EVENT_STORE = "events"
export const OUTBOX_STORE = "outbox"

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
      for (const name of [OBS_STORE, EVENT_STORE, OUTBOX_STORE]) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id", autoIncrement: true })
          store.createIndex("ts", "ts", { unique: false })
        }
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error ?? new Error("failed to open IndexedDB"))
    }
  })
  return dbPromise
}

function reqDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
    tx.onerror = () => {
      // The abort event carries the final error.
    }
  })
}

// --- kv (live state) -------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await open()
  return (await reqDone(db.transaction(KV_STORE, "readonly").objectStore(KV_STORE).get(key))) as
    | T
    | undefined
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await open()
  const tx = db.transaction(KV_STORE, "readwrite")
  tx.objectStore(KV_STORE).put(value, key)
  await txDone(tx)
}

export async function kvDelete(key: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(KV_STORE, "readwrite")
  tx.objectStore(KV_STORE).delete(key)
  await txDone(tx)
}

/** Atomically put kv entries, delete kv keys, AND append records to `store` in a single
 *  transaction, so they all commit together or not at all. Used to checkpoint the gauge
 *  state, drop the consumed Writer message, and enqueue effects durably in one step. */
export async function kvPutAndAppend(
  kv: Array<{ key: string; value: unknown }>,
  store: string,
  records: object[],
  kvDeletes: string[] = [],
): Promise<void> {
  const db = await open()
  const tx = db.transaction([KV_STORE, store], "readwrite")
  const kvOs = tx.objectStore(KV_STORE)
  for (const { key, value } of kv) kvOs.put(value, key)
  for (const key of kvDeletes) kvOs.delete(key)
  const recOs = tx.objectStore(store)
  for (const record of records) recOs.add(record)
  await txDone(tx)
}

/** Atomically put kv entries, delete kv keys, and clear whole stores in one transaction —
 *  for a reset that must not leave the gauge half-wiped (state cleared but effects revived,
 *  or vice versa) if it races a dispatch or the worker dies mid-way. */
export async function kvWriteAndClear(
  puts: Array<{ key: string; value: unknown }>,
  kvDeletes: string[],
  clearStores: string[],
): Promise<void> {
  const db = await open()
  const tx = db.transaction([KV_STORE, ...clearStores], "readwrite")
  const kvOs = tx.objectStore(KV_STORE)
  for (const { key, value } of puts) kvOs.put(value, key)
  for (const key of kvDeletes) kvOs.delete(key)
  for (const store of clearStores) tx.objectStore(store).clear()
  await txDone(tx)
}

// --- append-only record stores (observations / events) ---------------------------

/** Append a record (auto-id, stamped ts). Trims the store to `cap` newest by id. */
export async function addRecord(
  store: string,
  record: Record<string, unknown>,
  cap = 1000,
): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, "readwrite")
  const os = tx.objectStore(store)
  os.add(record)
  // Trim oldest entries beyond the cap (cursor over the primary key, ascending).
  const countReq = os.count()
  countReq.onsuccess = () => {
    let excess = countReq.result - cap
    if (excess <= 0) return
    const cursorReq = os.openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || excess <= 0) return
      cursor.delete()
      excess -= 1
      cursor.continue()
    }
  }
  await txDone(tx)
}

/** All records in a store, oldest first. */
export async function getAllRecords<T>(store: string): Promise<T[]> {
  const db = await open()
  return (await reqDone(db.transaction(store, "readonly").objectStore(store).getAll())) as T[]
}

export async function clearStore(store: string): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, "readwrite")
  tx.objectStore(store).clear()
  await txDone(tx)
}

/** Delete a single record by primary key. */
export async function deleteRecord(store: string, id: number): Promise<void> {
  const db = await open()
  const tx = db.transaction(store, "readwrite")
  tx.objectStore(store).delete(id)
  await txDone(tx)
}

/** Process each record (oldest id first) via `handler`; delete a record only when the
 *  handler resolves `true` (acknowledged). Returning `false` — or throwing — leaves the
 *  record for a later drain, so delivery is at-least-once. `false` is for work that owns its
 *  own async lifetime (e.g. a durable job that deletes its record when it truly completes);
 *  a throw is a transient failure to retry. */
export async function drainRecords<T extends { id: number }>(
  store: string,
  handler: (record: T) => Promise<boolean>,
): Promise<void> {
  const records = await getAllRecords<T>(store)
  for (const record of records) {
    let ack = false
    try {
      ack = await handler(record)
    } catch {
      ack = false // leave for retry
    }
    if (ack) await deleteRecord(store, record.id)
  }
}

/** Atomic compare-and-delete for a kv key: delete it only if `matches(currentValue)` — so a
 *  stale reader can't clobber a value another writer has since replaced. The read and the
 *  conditional delete run in one transaction. No-op if the key is absent or unmatched. */
export async function kvDeleteIf(
  key: string,
  matches: (value: unknown) => boolean,
): Promise<void> {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KV_STORE, "readwrite")
    const os = tx.objectStore(KV_STORE)
    const getReq = os.get(key)
    getReq.onsuccess = () => {
      // Issue the delete synchronously inside the same still-active transaction.
      if (getReq.result !== undefined && matches(getReq.result)) os.delete(key)
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("kvDeleteIf aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("kvDeleteIf failed"))
  })
}

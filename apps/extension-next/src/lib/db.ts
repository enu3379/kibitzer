// Durable local store (IndexedDB) — the serverless SSOT. Unlike chrome.storage.session
// (in-memory, wiped on browser restart) this survives restarts, so the immersion gauge,
// drift timing, and recent-visit context carry over. Available in the MV3 service worker
// via globalThis.indexedDB.
//
// Stores:
//   kv           — small live state, keyed by name (gauge checkpoint, drift-since, …)
//   observations — durable per-page observation log (P3: analytics / exemplar learning)
//   events       — structured, append-only event log (P2-2)

const DB_NAME = "kibitzer"
const DB_VERSION = 1
const KV_STORE = "kv"
export const OBS_STORE = "observations"
export const EVENT_STORE = "events"

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
      for (const name of [OBS_STORE, EVENT_STORE]) {
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

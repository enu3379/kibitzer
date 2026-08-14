// startupSettled barrier contract, in its own file ON PURPOSE: node --test runs each file in
// a fresh process, so this is the only place the barrier is still pristine when a test runs.
// Inside sessionRestore.test.ts the earlier scenarios (and the 1.5 s fallback timer) would
// have settled it long before any assertion — a check there is vacuously green.
//
// The property pinned: handleBrowserStartup entered BEFORE the fallback fires must itself
// settle the barrier (its entry clears the fallback timer, so if the try/finally settle were
// lost the barrier would never resolve — background.ts would then never run its gated
// startup drain, and the heartbeat/observe/get-state gates would hang a full relaunch).

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

const store = new Map<string, unknown>()
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (obj: Record<string, unknown>) =>
        void Object.entries(obj).forEach(([k, v]) => store.set(k, v)),
      remove: async (key: string) => void store.delete(key),
    },
  },
  action: {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  },
  runtime: { getURL: (p: string) => p },
  tabs: { query: async () => [] },
}
console.log = () => {}

// Import races the 1.5 s fallback from here on — run the decision immediately, well inside it.
const { handleBrowserStartup, startupSettled } = await import("./sessionRestore.ts")

test("the restart decision itself settles the barrier (fallback timer is cleared at entry)", async () => {
  await handleBrowserStartup() // no goal — the no-op path must settle too
  const settled = await Promise.race([
    startupSettled.then(() => true as const),
    // If the decision failed to settle, the cleared fallback can't save it — this guard
    // turns the would-be forever-hang into a loud failure.
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500)
      ;(timer as { unref?: () => void }).unref?.()
    }),
  ])
  assert.equal(settled, true, "startupSettled still pending after handleBrowserStartup returned")
})

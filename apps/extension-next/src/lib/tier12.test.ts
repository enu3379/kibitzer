import assert from "node:assert/strict"
import test from "node:test"

// A judge-less profile: chrome.storage answers empty, so no tier resolves to a provider.
// Installed before the import so the module's settings read has something to talk to.
const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys?: string | string[]) => {
        if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {}
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
        return { ...store }
      },
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
      remove: async () => {},
    },
  },
}

const { safeShouldContinue, tier2Confirm } = await import("./tier12.ts")

test("safeShouldContinue preserves a successful policy result", async () => {
  assert.equal(await safeShouldContinue(async () => true), true)
  assert.equal(await safeShouldContinue(async () => false), false)
})

test("safeShouldContinue treats a failed policy read as cancellation", async () => {
  assert.equal(
    await safeShouldContinue(async () => {
      throw new Error("extension context invalidated")
    }),
    false,
  )
})

test("with no Tier-2 route the outcome is UNAVAILABLE, not a clean verdict", async () => {
  // `flow: "ok"` is a real judgment — "this page does not warrant a nudge" — and the gauge acts
  // on it: refund S, zero the inertia and accel tier, flip the page to OK. Nothing was asked
  // here, so that reward would be invented. The flag is what lets the caller tell the two apart.
  const outcome = await tier2Confirm("파이썬 알고리즘 문제 풀이", {
    title: "귀여운 고양이 영상 몰아보기",
    urlHost: "video.test",
    score: 0.2,
  })
  assert.equal(outcome.unavailable, true, "no route configured ⇒ no judgment was obtained")
  assert.equal(outcome.message, null, "and certainly no written message")
})

// Declared after the case above on purpose: it configures a route, which that one needs absent.
test("a judge that cannot be reached is UNAVAILABLE too — not a verdict of 'fine'", async () => {
  // The everyday version of this: Ollama isn't running, the model was never pulled, the laptop
  // just woke up. Configure a real route through the public API (no guessing at stored shapes),
  // then make the call fail the way a dead endpoint does.
  const { addProviderKey, setRoutes } = await import("./providers.ts")
  await addProviderKey("ollama", "local", "test-key")
  await setRoutes({ tier2: { provider: "ollama", model: "llama3" } })
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  try {
    const outcome = await tier2Confirm("파이썬 알고리즘 문제 풀이", {
      title: "귀여운 고양이 영상 몰아보기",
      urlHost: "video.test",
      score: 0.2,
    })
    assert.equal(outcome.unavailable, true, "the judge was asked and did not answer")
    assert.ok(outcome.providerError, "and the failure is reported so the user can be told")
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

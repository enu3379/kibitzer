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

const { enrichGoal, safeShouldContinue, tier1Rescue, tier2Confirm } = await import("./tier12.ts")

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

// tierReached / tier_reached must mean "Tier 1 actually returned a verdict" — the tiers route
// independently (a Tier-2-only setup runs with Tier 1 keyless), so nothing about reaching a
// later gate may be taken as proof that Tier 1 ran. Issue #207.

test("a keyless Tier-1 route keeps DRIFT and reports that Tier 1 never answered", async () => {
  const { setRoutes } = await import("./providers.ts")
  // Tier 1 → a provider with no stored keys (Tier 2 keeps its keyed Ollama route from the
  // test above): the Tier-2-only configuration.
  await setRoutes({ tier1: { provider: "gemini", model: "gemini-3.1-flash-lite" } })
  const rescue = await tier1Rescue("파이썬 알고리즘 문제 풀이", "귀여운 고양이 영상", "video.test")
  assert.deepEqual(rescue, { verdict: "DRIFT", answered: false })
})

test("a Tier-1 call that fails keeps DRIFT without claiming Tier 1 answered", async () => {
  const { setRoutes } = await import("./providers.ts")
  await setRoutes({ tier1: { provider: "ollama", model: "llama3" } })
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  try {
    const rescue = await tier1Rescue("파이썬 알고리즘 문제 풀이", "귀여운 고양이 영상", "video.test")
    assert.deepEqual(rescue, { verdict: "DRIFT", answered: false })
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

test("a Tier-1 verdict that came back marks Tier 1 as answered", async () => {
  const { setRoutes } = await import("./providers.ts")
  // Providers bind globalThis.fetch at construction and are cached by settings fingerprint —
  // change the route so this test's provider is built while its own fetch mock is installed.
  await setRoutes({ tier1: { provider: "ollama", model: "nemotron-3-nano:30b" } })
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async () =>
    new Response(
      JSON.stringify({ message: { content: '{"verdict": "ok", "reason": "on goal"}' } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  try {
    const rescue = await tier1Rescue("파이썬 알고리즘 문제 풀이", "파이썬 BFS 문제", "algo.test")
    assert.deepEqual(rescue, { verdict: "OK", answered: true })
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

test("the Tier-2 judge is told the observe-time tier_reached, never an assumed 1", async () => {
  const { setRoutes } = await import("./providers.ts")
  // Same fingerprint bust as above: the cached Tier-2 provider was built under an earlier
  // test's fetch mock and would bypass the capturing one below.
  await setRoutes({ tier2: { provider: "ollama", model: "minimax-m3" } })
  const requestBodies: string[] = []
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: unknown }) => {
    requestBodies.push(String(init?.body ?? ""))
    return new Response(
      JSON.stringify({
        message: {
          content: '{"decision": "defer", "reason_code": "insufficient_evidence", "basis": "title"}',
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const sentTierReached = (body: string): unknown => {
    const messages = (JSON.parse(body) as { messages: { content: string }[] }).messages
    const payload = JSON.parse(messages[messages.length - 1].content) as {
      current: { tier_reached: unknown }
    }
    return payload.current.tier_reached
  }
  try {
    // The active-page record says Tier 1 never judged this page (Tier-2-only route, or the
    // Tier-1 call failed at observe time).
    let outcome = await tier2Confirm("파이썬 알고리즘 문제 풀이", {
      title: "귀여운 고양이 영상 몰아보기",
      urlHost: "video.test",
      score: 0.2,
      tierReached: 0,
    })
    assert.equal(outcome.flow, "ok")
    assert.equal(sentTierReached(requestBodies[0]), 0, "Tier 1 never ran ⇒ the judge must see 0")

    // And when the record says Tier 1 did answer, that is what gets forwarded.
    outcome = await tier2Confirm("파이썬 알고리즘 문제 풀이", {
      title: "귀여운 고양이 영상 몰아보기",
      urlHost: "video.test",
      score: 0.2,
      tierReached: 1,
    })
    assert.equal(outcome.flow, "ok")
    assert.equal(sentTierReached(requestBodies[1]), 1)

    // A record with no tierReached at all (checkpoint written before the field existed)
    // defaults to the value that claims nothing.
    outcome = await tier2Confirm("파이썬 알고리즘 문제 풀이", {
      title: "귀여운 고양이 영상 몰아보기",
      urlHost: "video.test",
      score: 0.2,
    })
    assert.equal(outcome.flow, "ok")
    assert.equal(sentTierReached(requestBodies[2]), 0)
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

// Goal enrichment routing (issue #207 결정 C): the one enrichment call per goal declaration may
// fall back to the Tier-2 route when Tier 1's route resolves to NO provider — and only then.
// A keyed Tier 1 whose call fails gets no retry elsewhere (automatic failover is #207 확인 3,
// deliberately out of scope), and enrichment never touches provider health in any direction.

const HEALTH_KEY = "kibitzer:provider-health:v1"
const enrichResponse = (): Response =>
  new Response(
    JSON.stringify({ message: { content: '{"phrases": ["파이썬 알고리즘 풀이", "python algorithm practice"]}' } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

test("a keyed Tier-1 route runs goal enrichment itself, as before", async () => {
  const { setRoutes } = await import("./providers.ts")
  // Fingerprint bust (see the tests above): a fresh model makes providers() rebuild under
  // this test's fetch mock.
  await setRoutes({ tier1: { provider: "ollama", model: "gpt-oss:20b" } })
  const requests: { url: string; model: unknown }[] = []
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: unknown }) => {
    requests.push({ url: String(url), model: (JSON.parse(String(init?.body)) as { model: unknown }).model })
    return enrichResponse()
  }
  try {
    const phrases = await enrichGoal("파이썬 알고리즘 문제 풀이")
    assert.equal(phrases.length, 2)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, "gpt-oss:20b", "the Tier-1 route's own model was asked")
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

test("a keyless Tier-1 route sends goal enrichment through the Tier-2 route instead", async () => {
  const { setRoutes } = await import("./providers.ts")
  // The Tier-2-only configuration: tier1 → a provider with no stored keys, tier2 keyed.
  await setRoutes({
    tier1: { provider: "gemini", model: "gemini-3.1-flash-lite" },
    tier2: { provider: "ollama", model: "qwen3.5:397b" },
  })
  const healthBefore = JSON.stringify(store[HEALTH_KEY] ?? null)
  const requests: { url: string; model: unknown }[] = []
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: { body?: unknown }) => {
    requests.push({ url: String(url), model: (JSON.parse(String(init?.body)) as { model: unknown }).model })
    return enrichResponse()
  }
  try {
    const phrases = await enrichGoal("파이썬 알고리즘 문제 풀이")
    assert.equal(phrases.length, 2, "enrichment still produced derived phrases")
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, "qwen3.5:397b", "the call went to the Tier-2 route's model")
    assert.ok(requests[0].url.includes("ollama.com"), "…via the Tier-2 route's provider")
    assert.equal(JSON.stringify(store[HEALTH_KEY] ?? null), healthBefore, "no health record, even on success")
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

test("a failing fallback enrichment call yields [] and leaves provider health untouched", async () => {
  const { setRoutes } = await import("./providers.ts")
  await setRoutes({ tier2: { provider: "ollama", model: "gemma4:31b" } }) // fingerprint bust, tier1 stays keyless
  const healthBefore = JSON.stringify(store[HEALTH_KEY] ?? null)
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("ECONNREFUSED")
  }
  try {
    const phrases = await enrichGoal("파이썬 알고리즘 문제 풀이")
    assert.deepEqual(phrases, [], "failure degrades to no derived phrases")
    assert.equal(JSON.stringify(store[HEALTH_KEY] ?? null), healthBefore, "enrichment never records an error")
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

test("with BOTH routes keyless, goal enrichment makes no call at all", async () => {
  const { setRoutes } = await import("./providers.ts")
  await setRoutes({
    tier1: { provider: "gemini", model: "gemini-3.1-flash-lite" },
    tier2: { provider: "gemini", model: "gemini-3.6-flash" },
  })
  let calls = 0
  const realFetch = globalThis.fetch
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    calls += 1
    throw new Error("must not be called")
  }
  try {
    const phrases = await enrichGoal("파이썬 알고리즘 문제 풀이")
    assert.deepEqual(phrases, [])
    assert.equal(calls, 0, "no provider ⇒ no network")
  } finally {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  }
})

import assert from "node:assert/strict"
import test from "node:test"

// Minimal chrome.storage.local over a plain object, installed before the import so the
// module's storage calls have something to talk to.
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
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]
      },
    },
  },
}

const {
  clearProviderHealth,
  getProviderHealth,
  HEALTH_TTL_MS,
  recordProviderError,
  recordProviderOk,
  tiersAffectedByProviderChange,
} = await import("./providerHealth.ts")

function reset(): void {
  for (const key of Object.keys(store)) delete store[key]
}

test("a Tier-1 success does not erase a live Tier-2 error — the #205 headline", async () => {
  reset()
  await recordProviderError("tier2", new Error("dead key"), "judge")
  await recordProviderOk("tier1")
  const health = await getProviderHealth()
  assert.equal(health.tier1?.ok, true)
  assert.equal(health.tier2?.ok, false, "the Tier-2 error must survive the Tier-1 success")
  assert.equal(health.tier2?.stage, "judge")
})

test("a Tier-2 success does not erase a live Tier-1 error either", async () => {
  reset()
  await recordProviderError("tier1", new Error("rescue down"))
  await recordProviderOk("tier2")
  const health = await getProviderHealth()
  assert.equal(health.tier1?.ok, false)
  assert.equal(health.tier1?.stage, undefined, "tier1 records carry no stage")
  assert.equal(health.tier2?.ok, true)
})

test("the failed Tier-2 stage is recorded, and within a tier the latest call wins", async () => {
  reset()
  await recordProviderError("tier2", new Error("judge down"), "judge")
  assert.equal((await getProviderHealth()).tier2?.stage, "judge")
  await recordProviderError("tier2", new Error("writer down"), "writer")
  const health = await getProviderHealth()
  assert.equal(health.tier2?.stage, "writer", "the slot means 'that tier's most recent call'")
})

test("a record older than 24h reads as absent; a younger one does not", async () => {
  reset()
  await recordProviderError("tier1", new Error("old"))
  await recordProviderError("tier2", new Error("old"), "judge")
  const snapshot = await getProviderHealth()
  const ts1 = snapshot.tier1?.ts
  const ts2 = snapshot.tier2?.ts
  assert.ok(ts1 && ts2)
  // Each record expires on ITS OWN clock (they can be milliseconds apart).
  const justBefore = await getProviderHealth(Math.min(ts1, ts2) + HEALTH_TTL_MS - 1)
  assert.equal(justBefore.tier1?.ok, false)
  assert.equal(justBefore.tier2?.ok, false)
  const expired = await getProviderHealth(Math.max(ts1, ts2) + HEALTH_TTL_MS)
  assert.equal(expired.tier1, null, "expired records must be invisible to every consumer")
  assert.equal(expired.tier2, null)
})

test("a record with a corrupt ts reads as absent, not as live-forever", async () => {
  reset()
  store["kibitzer:provider-health:tier1:v2"] = { ok: false, kind: "auth", message: "x", ts: "어제" }
  store["kibitzer:provider-health:tier2:v2"] = { ok: false, kind: "auth", message: "x" }
  const health = await getProviderHealth()
  assert.equal(health.tier1, null, "a non-numeric ts would compare as NaN and never expire")
  assert.equal(health.tier2, null)
})

test("clearProviderHealth is tier-scoped — clearing tier1 leaves tier2's record intact", async () => {
  reset()
  await recordProviderError("tier1", new Error("boom"))
  await recordProviderError("tier2", new Error("boom"), "writer")
  await clearProviderHealth(["tier1"])
  const health = await getProviderHealth()
  assert.equal(health.tier1, null)
  assert.equal(health.tier2?.ok, false, "the other tier's record is not collateral")
  await clearProviderHealth([])
  assert.equal((await getProviderHealth()).tier2?.ok, false, "an empty clear touches nothing")
  await clearProviderHealth(["tier1", "tier2"])
  assert.deepEqual(await getProviderHealth(), { tier1: null, tier2: null })
})

// --- which tiers a settings change touches ----------------------------------------

type ProviderId = import("./providers.ts").ProviderId

const routes = (t1: [ProviderId, string], t2: [ProviderId, string]) => ({
  tier1: { provider: t1[0], model: t1[1] },
  tier2: { provider: t2[0], model: t2[1] },
})

test("a key change on the tier1 route's provider affects tier1 only", () => {
  const r = routes(["gemini", "m1"], ["ollama", "m2"])
  assert.deepEqual(tiersAffectedByProviderChange("gemini", r, r), ["tier1"])
})

test("a key change on a provider both routes point to affects both tiers", () => {
  const r = routes(["ollama", "m1"], ["ollama", "m2"])
  assert.deepEqual(tiersAffectedByProviderChange("ollama", r, r), ["tier1", "tier2"])
})

test("a route change affects the changed tier only — model or provider alike", () => {
  const before = routes(["ollama", "m1"], ["ollama", "m2"])
  assert.deepEqual(
    tiersAffectedByProviderChange(null, before, routes(["ollama", "m1"], ["ollama", "m3"])),
    ["tier2"],
  )
  assert.deepEqual(
    tiersAffectedByProviderChange(null, before, routes(["gemini", "g1"], ["ollama", "m2"])),
    ["tier1"],
  )
  assert.deepEqual(tiersAffectedByProviderChange(null, before, before), [], "a no-op save touches nothing")
})

test("a key change that reroutes a tier onto the provider affects that tier too", () => {
  // The automatic-route logic can move a route WITH the key change (providers.ts) —
  // affected tiers are judged on the union of before and after.
  const before = routes(["ollama", "m1"], ["ollama", "m2"])
  const after = routes(["gemini", "g1"], ["gemini", "g2"])
  assert.deepEqual(tiersAffectedByProviderChange("gemini", before, after), ["tier1", "tier2"])
})

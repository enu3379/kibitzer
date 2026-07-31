// Provider settings storage: legacy kibitzer:ollama:v2 migration, route coercion,
// key mutations, and disconnect rerouting. chrome.storage.local stubbed in-memory.

import assert from "node:assert/strict"
import test from "node:test"

const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys]
        const out: Record<string, unknown> = {}
        for (const key of list) if (key in store) out[key] = store[key]
        return out
      },
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
      remove: async (key: string) => void delete store[key],
    },
  },
}

const {
  addProviderKey,
  connectProvider,
  disconnectProvider,
  getJudgeSettings,
  maskKeyValue,
  removeProviderKey,
  setRoutes,
  toPublicSettings,
} = await import("./providers.ts")

function reset(): void {
  for (const key of Object.keys(store)) delete store[key]
}

test("fresh install defaults to Ollama routes with the preset defaults", async () => {
  reset()
  const settings = await getJudgeSettings()
  assert.deepEqual(settings.routes.tier1, { provider: "ollama", model: "nemotron-3-nano:30b" })
  assert.deepEqual(settings.routes.tier2, { provider: "ollama", model: "minimax-m3" })
  assert.deepEqual(settings.accounts.ollama, { keys: [] })
  // migrated result is persisted
  assert.ok(store["kibitzer:providers:v1"])
})

test("legacy kibitzer:ollama:v2 migrates keys and models, keeping the legacy record", async () => {
  reset()
  store["kibitzer:ollama:v2"] = {
    apiUrl: "https://ollama.com/api/chat",
    apiKeys: ["key-a", "key-b"],
    tier1Model: "custom-t1",
    tier2Model: "",
  }
  const settings = await getJudgeSettings()
  const keys = settings.accounts.ollama?.keys ?? []
  assert.equal(keys.length, 2)
  assert.equal(keys[0].name, "키 1")
  assert.equal(keys[0].value, "key-a")
  assert.ok(keys[0].id)
  assert.equal(settings.routes.tier1.model, "custom-t1")
  assert.equal(settings.routes.tier2.model, "minimax-m3") // empty → preset default
  assert.ok(store["kibitzer:ollama:v2"], "legacy record kept for rollback")
})

test("add/remove key round-trips; masked view never carries the value", async () => {
  reset()
  await connectProvider("openrouter")
  let settings = await addProviderKey("openrouter", "  메인  ", " sk-or-v1-abcdef0123456789 ")
  const key = settings.accounts.openrouter?.keys[0]
  assert.ok(key)
  assert.equal(key.name, "메인")
  assert.equal(key.value, "sk-or-v1-abcdef0123456789")

  const publicView = toPublicSettings(settings)
  const pub = publicView.accounts.openrouter?.[0]
  assert.ok(pub)
  assert.equal(pub.masked, "sk-o····6789")
  assert.ok(!JSON.stringify(publicView).includes("abcdef0123456789"))

  settings = await removeProviderKey("openrouter", key.id)
  assert.equal(settings.accounts.openrouter?.keys.length, 0)
})

test("blank key value is ignored", async () => {
  reset()
  const settings = await addProviderKey("gemini", "이름만", "   ")
  assert.equal(settings.accounts.gemini?.keys.length ?? 0, 0)
})

test("disconnect drops the account and reroutes affected tiers to the Ollama defaults", async () => {
  reset()
  await addProviderKey("claude", "", "sk-ant-xyz")
  await setRoutes({ tier2: { provider: "claude", model: "claude-sonnet-5" } })
  let settings = await getJudgeSettings()
  assert.equal(settings.routes.tier2.provider, "claude")

  settings = await disconnectProvider("claude")
  assert.equal(settings.accounts.claude, undefined)
  assert.deepEqual(settings.routes.tier2, { provider: "ollama", model: "minimax-m3" })
})

test("ollama cannot be disconnected", async () => {
  reset()
  await addProviderKey("ollama", "", "k1")
  const settings = await disconnectProvider("ollama")
  assert.equal(settings.accounts.ollama?.keys.length, 1)
})

test("setRoutes falls back to the provider's preset default when the model is blank", async () => {
  reset()
  const settings = await setRoutes({ tier1: { provider: "deepseek", model: "  " } })
  assert.deepEqual(settings.routes.tier1, { provider: "deepseek", model: "deepseek-v4-flash" })
})

test("unknown provider in stored routes coerces back to defaults", async () => {
  reset()
  store["kibitzer:providers:v1"] = {
    accounts: { bogus: { keys: [] } },
    routes: { tier1: { provider: "bogus", model: "x" }, tier2: { provider: "deepseek", model: "deepseek-v4-pro" } },
  }
  const settings = await getJudgeSettings()
  assert.deepEqual(settings.routes.tier1, { provider: "ollama", model: "nemotron-3-nano:30b" })
  assert.deepEqual(settings.routes.tier2, { provider: "deepseek", model: "deepseek-v4-pro" })
  assert.ok(!("bogus" in settings.accounts))
})

test("maskKeyValue keeps only head and tail", () => {
  assert.equal(maskKeyValue("shortkey"), "sh····")
  assert.equal(maskKeyValue("sk-or-v1-abcdef0123456789"), "sk-o····6789")
})

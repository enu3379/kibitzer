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
  defaultProviderKeyName,
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

test("default API key names use the provider, local date, and provider-specific sequence", () => {
  const date = new Date(2026, 7, 1)
  assert.equal(defaultProviderKeyName("ollama", 0, date), "Ollama-260801-1")
  assert.equal(defaultProviderKeyName("claude", 2, date), "Claude-260801-3")
  assert.equal(defaultProviderKeyName("openai", 1, date), "OpenAI-260801-2")
})

test("fresh install defaults to Ollama routes with the preset defaults", async () => {
  reset()
  const settings = await getJudgeSettings()
  assert.deepEqual(settings.routes.tier1, { provider: "ollama", model: "nemotron-3-nano:30b" })
  assert.deepEqual(settings.routes.tier2, { provider: "ollama", model: "minimax-m3" })
  assert.deepEqual(settings.accounts.ollama, { keys: [] })
  assert.equal(settings.routesManuallyConfigured, false)
  // migrated result is persisted
  assert.ok(store["kibitzer:providers:v1"])
})

test("the first keyed non-Ollama provider automatically supplies both route defaults", async () => {
  reset()
  const settings = await addProviderKey("gemini", "", "gemini-key")
  assert.deepEqual(settings.routes.tier1, { provider: "gemini", model: "gemini-3.1-flash-lite" })
  assert.deepEqual(settings.routes.tier2, { provider: "gemini", model: "gemini-3.6-flash" })
})

test("additional non-Ollama providers do not replace the first keyed provider", async () => {
  reset()
  await addProviderKey("openrouter", "", "openrouter-key")
  const settings = await addProviderKey("gemini", "", "gemini-key")
  assert.equal(settings.routes.tier1.provider, "openrouter")
  assert.equal(settings.routes.tier2.provider, "openrouter")
})

test("adding an Ollama key restores both automatic routes to Ollama defaults", async () => {
  reset()
  await addProviderKey("deepseek", "", "deepseek-key")
  const settings = await addProviderKey("ollama", "", "ollama-key")
  assert.deepEqual(settings.routes.tier1, { provider: "ollama", model: "nemotron-3-nano:30b" })
  assert.deepEqual(settings.routes.tier2, { provider: "ollama", model: "minimax-m3" })
})

test("saved manual routes disable all later key-based suggestions", async () => {
  reset()
  await addProviderKey("gemini", "", "gemini-key")
  await setRoutes({
    tier1: { provider: "gemini", model: "gemini-3.1-flash-lite" },
    tier2: { provider: "gemini", model: "gemini-3.6-flash" },
  })
  const settings = await addProviderKey("ollama", "", "ollama-key")
  assert.equal(settings.routesManuallyConfigured, true)
  assert.equal(settings.routes.tier1.provider, "gemini")
  assert.equal(settings.routes.tier2.provider, "gemini")
})

test("concurrent route save and key add preserve both mutations", async () => {
  reset()
  await Promise.all([
    setRoutes({
      tier1: { provider: "openai", model: "gpt-5.4-nano" },
      tier2: { provider: "openai", model: "gpt-5.6-luna" },
    }),
    addProviderKey("gemini", "", "gemini-key"),
  ])

  const settings = await getJudgeSettings()
  assert.equal(settings.routesManuallyConfigured, true)
  assert.equal(settings.routes.tier1.provider, "openai")
  assert.equal(settings.routes.tier2.provider, "openai")
  assert.equal(settings.accounts.gemini?.keys[0]?.value, "gemini-key")
})

test("stored routes from before the manual flag preserve non-default user choices", async () => {
  reset()
  store["kibitzer:providers:v1"] = {
    accounts: { ollama: { keys: [] }, claude: { keys: [] } },
    routes: {
      tier1: { provider: "claude", model: "claude-haiku-4-5" },
      tier2: { provider: "claude", model: "claude-sonnet-5" },
    },
  }
  const settings = await addProviderKey("ollama", "", "ollama-key")
  assert.equal(settings.routesManuallyConfigured, true)
  assert.equal(settings.routes.tier1.provider, "claude")
  assert.equal(settings.routes.tier2.provider, "claude")
})

test("existing keyed v1 settings conservatively preserve a possible manual route", async () => {
  reset()
  store["kibitzer:providers:v1"] = {
    accounts: {
      ollama: { keys: [] },
      gemini: { keys: [{ id: "g1", name: "", value: "gemini-key", addedAt: 1 }] },
    },
    routes: {
      tier1: { provider: "ollama", model: "nemotron-3-nano:30b" },
      tier2: { provider: "ollama", model: "minimax-m3" },
    },
  }
  const settings = await getJudgeSettings()
  assert.equal(settings.routesManuallyConfigured, true)
  assert.equal(settings.automaticRouteProvider, "ollama")
  assert.equal(settings.routes.tier1.provider, "ollama")
  assert.equal(settings.routes.tier2.provider, "ollama")
})

test("removing the first key does not dislodge the first provider while another key remains", async () => {
  reset()
  let settings = await addProviderKey("gemini", "first", "gemini-a")
  const firstGeminiKey = settings.accounts.gemini?.keys[0]
  assert.ok(firstGeminiKey)
  await addProviderKey("openai", "", "openai-a")
  await addProviderKey("gemini", "second", "gemini-b")

  settings = await removeProviderKey("gemini", firstGeminiKey.id)
  assert.equal(settings.automaticRouteProvider, "gemini")
  assert.equal(settings.accounts.gemini?.keys.length, 1)
  assert.equal(settings.routes.tier1.provider, "gemini")
  assert.equal(settings.routes.tier2.provider, "gemini")
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

test("concurrent removals cannot empty an actively routed provider key pool", async () => {
  reset()
  let settings = await addProviderKey("ollama", "first", "key-a")
  settings = await addProviderKey("ollama", "second", "key-b")
  const ids = settings.accounts.ollama?.keys.map((key) => key.id) ?? []
  assert.equal(ids.length, 2)

  await Promise.all(ids.map((id) => removeProviderKey("ollama", id, true)))

  settings = await getJudgeSettings()
  assert.equal(settings.accounts.ollama?.keys.length, 1)
})

test("protected route saves reject a provider without a key", async () => {
  reset()
  await addProviderKey("ollama", "", "key-a")
  await connectProvider("openai")

  const settings = await setRoutes({
    tier2: { provider: "openai", model: "gpt-5.4-mini" },
  }, true)

  assert.equal(settings.routes.tier2.provider, "ollama")
  assert.equal(settings.routesManuallyConfigured, false)
})

test("a blank key name is saved as the provider/date/sequence default", async () => {
  reset()
  const settings = await addProviderKey("ollama", "   ", "key-a")
  const name = settings.accounts.ollama?.keys[0]?.name
  assert.match(name ?? "", /^Ollama-\d{6}-1$/)
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

test("a routed provider cannot be disconnected while protection is enabled", async () => {
  reset()
  await addProviderKey("claude", "", "sk-ant-xyz")
  const settings = await disconnectProvider("claude", true)
  assert.ok(settings.accounts.claude)
  assert.equal(settings.routes.tier1.provider, "claude")
  assert.equal(settings.routes.tier2.provider, "claude")
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

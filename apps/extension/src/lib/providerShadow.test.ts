import assert from "node:assert/strict"
import test from "node:test"

import {
  parseProviderShadowConfig,
  parseProviderShadowSnapshot,
} from "./providerShadow.ts"

test("provider shadow defaults to local Tier 0 and no network providers", () => {
  assert.deepEqual(parseProviderShadowConfig(undefined), {
    version: 1,
    tier0: { enabled: true, tauOk: 0.59 },
    tier1: null,
    tier2: null,
  })
})

test("provider shadow validates and clamps explicit Ollama settings", () => {
  const config = parseProviderShadowConfig({
    tier0: { enabled: false, tauOk: 4 },
    tier1: {
      enabled: true,
      apiUrl: "http://127.0.0.1:11434/api/chat",
      model: "  qwen-test  ",
      apiKeys: ["a", "", 4, "b"],
      timeoutMs: 1,
      maxOutputTokens: 0,
      writerMaxOutputTokens: 99_999,
    },
    tier2: {
      enabled: true,
      apiUrl: "file:///not-allowed",
      model: "judge",
    },
  })

  assert.deepEqual(config, {
    version: 1,
    tier0: { enabled: false, tauOk: 1 },
    tier1: {
      enabled: true,
      apiUrl: "http://127.0.0.1:11434/api/chat",
      model: "qwen-test",
      apiKeys: ["a", "b"],
      timeoutMs: 100,
      maxOutputTokens: 1,
      writerMaxOutputTokens: 16_384,
    },
    tier2: null,
  })
})

test("provider shadow rejects malformed persisted diagnostics", () => {
  assert.equal(parseProviderShadowSnapshot(null), null)
  assert.equal(parseProviderShadowSnapshot({
    version: 1,
    sessionId: "session-1",
    tier0: { result: "success" },
    tier1: null,
  }), null)
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  KIBITZER_PROTOCOL_VERSION,
  KIBITZER_SERVICE,
} from "../src/generated/portCandidates.ts"
import { putSettings } from "../src/lib/api.ts"
import { createChromeMock } from "./helpers/chrome.mjs"

const SETTINGS = {
  persona: "dry_kibitzer",
  voice_enabled: false,
  relevance: { tau_ok: 0.15 },
  controller: {
    type: "streak",
    k: 4,
    alignment_alpha: 0.85,
    theta_low: 0.15,
    theta_high: 0.3,
  },
  cooldown: { enabled: true, seconds: 30 },
  dwell: { observation_seconds: 5, tier2_seconds: 10 },
  quiet_hours: { enabled: false, start: "09:00", end: "18:00" },
}

const originalFetch = globalThis.fetch
const originalChrome = globalThis.chrome
test.beforeEach(() => {
  globalThis.chrome = createChromeMock().chrome
})
test.afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.chrome = originalChrome
})

function identityResponse() {
  return new Response(
    JSON.stringify({
      service: KIBITZER_SERVICE,
      protocol_version: KIBITZER_PROTOCOL_VERSION,
      instance_id: "settings-api-test",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

test("settings network failure is unreachable", async () => {
  globalThis.fetch = async () => {
    throw new Error("connection refused")
  }

  assert.deepEqual(await putSettings({ controller: { k: 4 } }), { kind: "unreachable" })
})

test("settings HTTP validation error preserves status and detail", async () => {
  globalThis.fetch = async (url) =>
    new URL(url).pathname === "/identity"
      ? identityResponse()
      : new Response(
          JSON.stringify({ detail: [{ msg: "Input should be less than or equal to 20" }] }),
          { status: 422, headers: { "content-type": "application/json" } },
        )

  assert.deepEqual(await putSettings({ controller: { k: 21 } }), {
    kind: "http_error",
    status: 422,
    detail: "Input should be less than or equal to 20",
  })
})

test("successful settings update returns canonical server settings", async () => {
  globalThis.fetch = async (url) =>
    new URL(url).pathname === "/identity"
      ? identityResponse()
      : new Response(JSON.stringify(SETTINGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        })

  assert.deepEqual(await putSettings({ controller: { k: 4 } }), {
    kind: "updated",
    settings: SETTINGS,
  })
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  KIBITZER_PROTOCOL_VERSION,
  KIBITZER_SERVICE,
} from "../src/generated/portCandidates.ts"
import { postBrowserNav } from "../src/lib/api.ts"
import { createChromeMock } from "./helpers/chrome.mjs"

test("browser-nav sends the stable idempotency key with every attempt", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  const requests = []
  globalThis.chrome = createChromeMock().chrome
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === "/identity") {
      return new Response(JSON.stringify({
        service: KIBITZER_SERVICE,
        protocol_version: KIBITZER_PROTOCOL_VERSION,
        instance_id: "api-test",
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    requests.push({ url, options })
    return new Response(
      JSON.stringify({ action: "none", observation_id: "obs_test" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  try {
    const result = await postBrowserNav(
      { url: "https://example.com/page", title: "Page", tab_id: 7 },
      "nav_stable_key",
    )
    await postBrowserNav(
      { url: "https://example.com/page", title: "Page", tab_id: 7 },
      "nav_stable_key",
    )

    assert.equal(result.observation_id, "obs_test")
    assert.equal(requests.length, 2)
    assert.deepEqual(
      requests.map(({ options }) => JSON.parse(options.body).idempotency_key),
      ["nav_stable_key", "nav_stable_key"],
    )
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }
})

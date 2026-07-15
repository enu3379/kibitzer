import assert from "node:assert/strict"
import test from "node:test"

import {
  KIBITZER_PROTOCOL_VERSION,
  KIBITZER_SERVICE,
} from "../src/generated/portCandidates.ts"
import { deleteAllActivityData, postBrowserNav, setGoal } from "../src/lib/api.ts"
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

test("activity deletion sends explicit confirmation and validates the response", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  const requests = []
  globalThis.chrome = createChromeMock().chrome
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === "/identity") {
      return new Response(JSON.stringify({
        service: KIBITZER_SERVICE,
        protocol_version: KIBITZER_PROTOCOL_VERSION,
        instance_id: "delete-test",
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    requests.push({ url, options })
    return new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    assert.equal(await deleteAllActivityData(), true)
    assert.equal(new URL(requests[0].url).pathname, "/data/delete")
    assert.equal(requests[0].options.method, "POST")
    assert.deepEqual(JSON.parse(requests[0].options.body), { confirm: "DELETE" })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }
})

test("goal setup asks the server to ensure the current session", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  const requests = []
  globalThis.chrome = createChromeMock().chrome
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === "/identity") {
      return new Response(JSON.stringify({
        service: KIBITZER_SERVICE,
        protocol_version: KIBITZER_PROTOCOL_VERSION,
        instance_id: "goal-test",
      }), { status: 200, headers: { "content-type": "application/json" } })
    }
    requests.push({ url, options })
    return new Response(JSON.stringify({
      session_id: "sess_test",
      raw_text: "Read the docs",
      provenance: "declared",
      updated_at: "2026-07-16T00:00:00Z",
      available_time_minutes: 30,
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    const goal = await setGoal("Read the docs", 30, true)

    assert.equal(goal.raw_text, "Read the docs")
    assert.equal(requests.length, 1)
    const url = new URL(requests[0].url)
    assert.equal(url.pathname, "/sessions/current/goal")
    assert.equal(url.searchParams.get("ensure_session"), "true")
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }
})

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  KIBITZER_PORT_CANDIDATES,
  KIBITZER_PROTOCOL_VERSION,
  KIBITZER_SERVICE,
} from "../src/generated/portCandidates.ts"
import { discoverServerPort } from "../src/lib/serverConnection.ts"

const originalChrome = globalThis.chrome
const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.fetch = originalFetch
})

function installLocalStorage(cachedPort) {
  let value = cachedPort
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return value === undefined ? {} : { [key]: value }
        },
        async set(values) {
          value = Object.values(values)[0]
        },
        async remove() {
          value = undefined
        },
      },
    },
  }
  return () => value
}

function identityResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      service: KIBITZER_SERVICE,
      protocol_version: KIBITZER_PROTOCOL_VERSION,
      instance_id: "instance-test",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

test("generated candidate list matches the packaged server contract", async () => {
  const source = JSON.parse(
    await readFile(new URL("../../server/app/port-candidates.json", import.meta.url), "utf8"),
  )

  assert.equal(KIBITZER_SERVICE, source.service)
  assert.equal(KIBITZER_PROTOCOL_VERSION, source.protocol_version)
  assert.deepEqual([...KIBITZER_PORT_CANDIDATES], source.ports)
})

test("stale cached port falls back to the ordered pool and updates the cache", async () => {
  const cachedPort = KIBITZER_PORT_CANDIDATES[1]
  const firstPort = KIBITZER_PORT_CANDIDATES[0]
  const cached = installLocalStorage(cachedPort)
  const probes = []
  globalThis.fetch = async (url) => {
    const port = Number(new URL(url).port)
    probes.push(port)
    if (port === cachedPort) throw new Error("stale cache")
    if (port === firstPort) return identityResponse()
    throw new Error("unexpected probe")
  }

  assert.equal(await discoverServerPort(), firstPort)
  assert.deepEqual(probes, [cachedPort, firstPort])
  assert.equal(cached(), firstPort)
})

test("unrelated service is rejected before accepting the next candidate", async () => {
  installLocalStorage(undefined)
  const probes = []
  globalThis.fetch = async (url) => {
    const port = Number(new URL(url).port)
    probes.push(port)
    return port === KIBITZER_PORT_CANDIDATES[0]
      ? identityResponse({ service: "other" })
      : identityResponse()
  }

  assert.equal(await discoverServerPort(), KIBITZER_PORT_CANDIDATES[1])
  assert.deepEqual(probes, KIBITZER_PORT_CANDIDATES.slice(0, 2))
})

test("all unavailable candidates clear the stale cache", async () => {
  const cached = installLocalStorage(KIBITZER_PORT_CANDIDATES[0])
  const probes = []
  globalThis.fetch = async (url) => {
    probes.push(Number(new URL(url).port))
    return identityResponse({ protocol_version: 99 })
  }

  assert.equal(await discoverServerPort(), null)
  assert.deepEqual(probes, [...KIBITZER_PORT_CANDIDATES])
  assert.equal(cached(), undefined)
})

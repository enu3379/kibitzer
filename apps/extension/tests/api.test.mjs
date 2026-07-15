import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import test from "node:test"

import { parsePipelineResult, postBrowserNav, sanitizeBrowserNavPayload } from "../src/lib/api.ts"
import { pairWithServer } from "../src/lib/auth.ts"
import { shouldDropUrl } from "../src/lib/domainFilter.ts"

const AUTH_SECRET = Buffer.from(Array.from({ length: 32 }, (_, index) => index))

function installAuthStorage(initialSecret = AUTH_SECRET.toString("hex")) {
  const values = { "kibitzer.localApiSecret": initialSecret }
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: values[key] }
        },
        async set(update) {
          Object.assign(values, update)
        },
      },
    },
  }
  return values
}

function authenticatedJsonResponse(url, init, value, secret = AUTH_SECRET) {
  const requestHeaders = new Headers(init.headers)
  const requestTimestamp = requestHeaders.get("x-kibitzer-timestamp")
  const requestNonce = requestHeaders.get("x-kibitzer-nonce")
  const requestSignature = requestHeaders.get("x-kibitzer-signature")
  assert.match(requestTimestamp, /^\d+$/)
  assert.match(requestNonce, /^[0-9a-f]{32}$/)
  const parsedUrl = new URL(url)
  const requestBodyHash = createHash("sha256").update(init.body ?? "").digest("hex")
  const expectedRequestSignature = createHmac("sha256", secret)
    .update(
      `kibitzer-request-v1\n${requestTimestamp}\n${requestNonce}\n${init.method ?? "GET"}\n${parsedUrl.pathname}${parsedUrl.search}\n${requestBodyHash}`,
    )
    .digest("hex")
  assert.equal(requestSignature, expectedRequestSignature)
  const responseBody = JSON.stringify(value)
  const bodyHash = createHash("sha256").update(responseBody).digest("hex")
  const proof = createHmac("sha256", secret)
    .update(`kibitzer-response-v1\n${requestNonce}\n200\n${bodyHash}`)
    .digest("hex")
  return new Response(responseBody, {
    status: 200,
    headers: { "content-type": "application/json", "x-kibitzer-response-proof": proof },
  })
}

test("minimizes navigation payloads before sending them to localhost", () => {
  const payload = sanitizeBrowserNavPayload({
    url: "https://example.com/private/path?access_token=secret#fragment",
    title: "x".repeat(2_100),
    tab_id: 7,
  })

  assert.deepEqual(payload, {
    url: "https://example.com/",
    title: "x".repeat(2_000),
    tab_id: 7,
  })
  assert.equal(sanitizeBrowserNavPayload({ url: "file:///tmp/private", title: "private" }), null)
})

test("sends only origin, title, and a location hash to localhost", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  installAuthStorage()
  let requestBody
  globalThis.fetch = async (url, init) => {
    requestBody = JSON.parse(init.body)
    return authenticatedJsonResponse(url, init, { action: "none" })
  }
  try {
    await postBrowserNav({
      url: "https://example.com/private/path?access_token=secret#fragment",
      title: "Private page",
      tab_id: 3,
    })
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }

  assert.equal(requestBody.payload.url, "https://example.com/")
  assert.equal(requestBody.payload.title, "Private page")
  assert.equal(requestBody.payload.url_path_hash.length, 64)
  assert.doesNotMatch(JSON.stringify(requestBody), /private|access_token|secret|fragment/)
})

test("rejects a forged localhost response without the server proof", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  installAuthStorage()
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ action: "request_excerpt", observation_id: `obs_${"a".repeat(32)}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  try {
    const result = await postBrowserNav({ url: "https://example.com/", title: "Page", tab_id: 1 })
    assert.equal(result, null)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }
})

test("pairs without sending the displayed code or client secret in plaintext", async () => {
  const originalFetch = globalThis.fetch
  const originalChrome = globalThis.chrome
  const stored = installAuthStorage(undefined)
  const code = "ab".repeat(32)
  let serializedRequest = ""
  globalThis.fetch = async (_url, init) => {
    serializedRequest = String(init.body)
    const body = JSON.parse(serializedRequest)
    const pairKey = createHash("sha256").update(code).digest()
    const expectedTag = createHmac("sha256", pairKey)
      .update(`kibitzer-pair-request-v1\n${body.client_nonce}\n${body.wrapped_secret}`)
      .digest("hex")
    assert.equal(body.tag, expectedTag)
    const mask = createHmac("sha256", pairKey)
      .update(`kibitzer-pair-wrap-v1\n${body.client_nonce}`)
      .digest()
    const secret = Buffer.from(body.wrapped_secret, "hex").map((byte, index) => byte ^ mask[index])
    const proof = createHmac("sha256", secret)
      .update(`kibitzer-pair-response-v1\n${body.client_nonce}`)
      .digest("hex")
    return new Response(JSON.stringify({ paired: true, proof }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    assert.equal(await pairWithServer(code), true)
    assert.match(stored["kibitzer.localApiSecret"], /^[0-9a-f]{64}$/)
    assert.doesNotMatch(serializedRequest, new RegExp(code))
    assert.doesNotMatch(serializedRequest, new RegExp(stored["kibitzer.localApiSecret"]))
  } finally {
    globalThis.fetch = originalFetch
    globalThis.chrome = originalChrome
  }
})

test("accepts only structurally valid pipeline responses", () => {
  const observationId = `obs_${"a".repeat(32)}`
  const candidateId = `cand_${"b".repeat(32)}`

  assert.deepEqual(
    parsePipelineResult({
      action: "request_excerpt",
      observation_id: observationId,
      candidate_id: candidateId,
      verdict: "DRIFT",
    }),
    {
      action: "request_excerpt",
      observation_id: observationId,
      candidate_id: candidateId,
      verdict: "DRIFT",
    },
  )
  assert.equal(
    parsePipelineResult({ action: "request_excerpt", observation_id: "attacker-controlled", candidate_id: candidateId }),
    null,
  )
  assert.equal(parsePipelineResult({ action: "request_excerpt" }), null)
  assert.equal(parsePipelineResult({ action: "request_excerpt", observation_id: observationId }), null)
  assert.equal(parsePipelineResult({ action: "notify", message: "x".repeat(4_001) }), null)
  assert.equal(parsePipelineResult({ action: "extract_everything" }), null)
})

test("drops non-web and loopback navigation targets", () => {
  assert.equal(shouldDropUrl("file:///Users/alice/private.pdf"), true)
  assert.equal(shouldDropUrl("chrome://settings/passwords"), true)
  assert.equal(shouldDropUrl("data:text/plain,private"), true)
  assert.equal(shouldDropUrl("http://127.0.0.1:8765/docs"), true)
  assert.equal(shouldDropUrl("https://example.com/docs"), false)
})

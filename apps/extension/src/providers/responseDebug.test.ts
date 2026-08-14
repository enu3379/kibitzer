import assert from "node:assert/strict"
import test from "node:test"

import { clearLog, klog, logText } from "../lib/klog.ts"
import { ProviderResponseError } from "./errors.ts"
import {
  readProviderJson,
  withRawResponseDebug,
  withResponseDebug,
} from "./responseDebug.ts"

const storage = new Map<string, unknown>()
let removeFailure: Error | null = null

globalThis.chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage.get(key) }),
      set: async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, value)
      },
      remove: async (key: string) => {
        if (removeFailure) throw removeFailure
        storage.delete(key)
      },
    },
  },
} as unknown as typeof chrome

test("non-JSON HTTP response is preserved verbatim in the debug log", async () => {
  await clearLog()
  const rawResponse = "upstream gateway returned HTML\n<error>bad response</error>"

  await assert.rejects(
    readProviderJson(new Response(rawResponse), "test transport"),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "http_json"
    ),
  )

  assert.match(
    await logText(),
    /llm response raw \(test transport, http_json\): upstream gateway returned HTML\n<error>bad response<\/error>/,
  )
})

test("parsed response is preserved verbatim when later envelope validation fails", async () => {
  await clearLog()
  const rawResponse = '{\n  "unexpected": "shape"\n}'
  const response = await readProviderJson(new Response(rawResponse), "test transport")

  assert.throws(
    () => withResponseDebug(response, "test judge", () => {
      throw new ProviderResponseError("envelope", "missing content")
    }),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "envelope"
    ),
  )

  assert.match(
    await logText(),
    /llm response raw \(test judge, envelope\): \{\n  "unexpected": "shape"\n\}/,
  )
})

test("higher-level content parsing preserves the returned model text", async () => {
  await clearLog()
  const rawResponse = "not a JSON enrichment response"

  assert.throws(
    () => withRawResponseDebug(rawResponse, "goal enrichment", "content_json", () => {
      throw new Error("no JSON object")
    }),
  )

  assert.match(
    await logText(),
    /llm response raw \(goal enrichment, content_json\): not a JSON enrichment response/,
  )
})

test("clearing waits for pending raw-response log writes", async () => {
  await clearLog()
  klog("llm response raw (test, envelope): sensitive response")

  await clearLog()

  assert.equal(await logText(), "")
})

test("an oversized response body is capped before it reaches storage", async () => {
  await clearLog()
  // The http_json stage fires on bodies that never came from the model — a proxy or
  // gateway page can be arbitrarily large, and storage.local has a 10MB quota.
  const rawResponse = "x".repeat(20000)

  await assert.rejects(readProviderJson(new Response(rawResponse), "test transport"))

  const text = await logText()
  assert.match(text, /… \(truncated, 20000 chars total\)$/)
  assert.ok(text.length < 10000, `entry should be capped, got ${text.length}`)
})

test("a failed clear does not poison later reads", async () => {
  await clearLog()
  klog("llm response raw (test, envelope): kept after a failed clear")
  removeFailure = new Error("storage unavailable")

  await assert.rejects(clearLog(), /storage unavailable/)
  removeFailure = null

  // readLog() awaits the shared append queue, so a rejected chain would throw here.
  assert.match(await logText(), /kept after a failed clear/)
})

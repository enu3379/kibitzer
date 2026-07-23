import assert from "node:assert/strict"
import test from "node:test"

import { ProviderResponseError } from "./errors.ts"
import { OllamaChatJudgeProvider } from "./ollamaChat.ts"
import {
  TIER1_OLLAMA_SYSTEM_PROMPT,
  TIER2_JUDGE_SYSTEM_PROMPT,
} from "./prompts.ts"

interface RecordedCall {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function recordingFetch(
  responses: Response[],
  calls: RecordedCall[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url: String(input), init: init ?? {}, body })
    const response = responses.shift()
    if (!response) throw new Error("unexpected fetch")
    return response
  }) as typeof fetch
}

test("Tier 1 sends the canonical minimized Ollama chat request", async () => {
  const calls: RecordedCall[] = []
  const provider = new OllamaChatJudgeProvider({
    apiUrl: "http://127.0.0.1:11434/api/chat",
    model: "qwen-test",
    apiKey: "test-key",
    maxOutputTokens: 128,
    fetch: recordingFetch([
      jsonResponse({
        message: {
          content: '{"verdict":"ok","reason":"normal subtopic"}',
        },
      }),
    ], calls),
  })

  assert.deepEqual(
    await provider.classifyTier1({
      goal: "논문 읽기",
      current: { title: "Methods" },
    }),
    { verdict: "OK", reason: "normal subtopic" },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat")
  assert.equal(
    (calls[0].init.headers as Record<string, string>).authorization,
    "Bearer test-key",
  )
  assert.deepEqual(calls[0].body, {
    model: "qwen-test",
    messages: [
      { role: "system", content: TIER1_OLLAMA_SYSTEM_PROMPT },
      {
        role: "user",
        content: '{"goal":"논문 읽기","current":{"title":"Methods"}}',
      },
    ],
    stream: false,
    options: { temperature: 0, num_predict: 128 },
    format: "json",
  })
})

test("API keys rotate per call and retry auth failures without exposing bodies", async () => {
  const calls: RecordedCall[] = []
  const provider = new OllamaChatJudgeProvider({
    apiUrl: "https://ollama.example/api/chat",
    model: "judge",
    apiKeys: ["key-a", "key-b", "key-c"],
    fetch: recordingFetch([
      jsonResponse({ error: "do not expose" }, 401),
      jsonResponse({ message: { content: '{"verdict":"ok","reason":"ok"}' } }),
      jsonResponse({ message: { content: '{"verdict":"drift","reason":"drift"}' } }),
    ], calls),
  })

  assert.equal((await provider.classifyTier1({})).verdict, "OK")
  assert.equal((await provider.classifyTier1({})).verdict, "DRIFT")
  assert.deepEqual(
    calls.map(
      (call) => (call.init.headers as Record<string, string>).authorization,
    ),
    ["Bearer key-a", "Bearer key-b", "Bearer key-b"],
  )
})

test("Tier 2 judge maps wire enums and uses the canonical trust-boundary prompt", async () => {
  const calls: RecordedCall[] = []
  const provider = new OllamaChatJudgeProvider({
    apiUrl: "http://127.0.0.1:11434/api/chat",
    model: "judge",
    fetch: recordingFetch([
      jsonResponse({
        message: {
          content:
            '{"decision":"defer","reason_code":"useful_side_branch","basis":"content"}',
        },
      }),
    ], calls),
  })

  assert.deepEqual(await provider.decideTier2({ goal: "논문 읽기" }), {
    decision: "defer",
    reasonCode: "useful_side_branch",
    basis: "content",
  })
  const messages = calls[0].body.messages as Array<Record<string, unknown>>
  assert.equal(messages[0].content, TIER2_JUDGE_SYSTEM_PROMPT)
})

test("truncated malformed judge output becomes output_exhausted", async () => {
  const provider = new OllamaChatJudgeProvider({
    apiUrl: "http://127.0.0.1:11434/api/chat",
    model: "judge",
    maxOutputTokens: 4,
    fetch: recordingFetch([
      jsonResponse({
        message: { content: '{"verdict":' },
        eval_count: 4,
      }),
    ], []),
  })

  await assert.rejects(
    provider.classifyTier1({}),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "output_exhausted"
    ),
  )
})

test("writer disables JSON/thinking, rejects empty output, and caps Unicode text", async () => {
  const calls: RecordedCall[] = []
  const longText = "🐈".repeat(321)
  const provider = new OllamaChatJudgeProvider({
    apiUrl: "http://127.0.0.1:11434/api/chat",
    model: "writer",
    writerMaxOutputTokens: 64,
    fetch: recordingFetch([
      jsonResponse({ message: { content: longText } }),
      jsonResponse({ message: { content: " " } }),
    ], calls),
  })

  assert.equal(
    Array.from(await provider.writeTier2Message({}, "writer prompt")).length,
    320,
  )
  assert.equal(calls[0].body.format, undefined)
  assert.equal(calls[0].body.think, false)
  await assert.rejects(
    provider.writeTier2Message({}, "writer prompt"),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "writer_empty"
    ),
  )
})

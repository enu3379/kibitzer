// OpenAI chat.completions adapter: wire shape, gpt-5.x quirks, key rotation on
// auth/limit statuses, judge parsing, and the usage callback.

import assert from "node:assert/strict"
import test from "node:test"

import { OpenAIChatJudgeProvider } from "./openaiChat.ts"
import { TIER1_OLLAMA_SYSTEM_PROMPT } from "./prompts.ts"

interface RecordedCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function recordingFetch(responses: Response[], calls: RecordedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    const response = responses.shift()
    if (!response) throw new Error("unexpected fetch")
    return response
  }) as typeof fetch
}

function chatCompletion(content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 15 },
    ...extra,
  }
}

test("Tier 1 sends a canonical chat.completions request and parses the verdict", async () => {
  const calls: RecordedCall[] = []
  const usage: Array<[number, number]> = []
  const provider = new OpenAIChatJudgeProvider({
    chatUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash",
    apiKeys: ["sk-test"],
    maxOutputTokens: 4096,
    fetch: recordingFetch(
      [jsonResponse(chatCompletion('{"verdict": "ok", "reason": "on goal"}'))],
      calls,
    ),
    onUsage: (i, o) => void usage.push([i, o]),
  })

  const result = await provider.classifyTier1({ goal: "테스트" })
  assert.equal(result.verdict, "OK")

  assert.equal(calls.length, 1)
  const { body, headers } = calls[0]
  assert.equal(body.model, "deepseek-v4-flash")
  assert.equal(body.stream, false)
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.temperature, 0)
  assert.equal(body.response_format, undefined) // parser tolerates prose-wrapped JSON
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.equal(messages[0].role, "system")
  assert.equal(messages[0].content, TIER1_OLLAMA_SYSTEM_PROMPT)
  assert.equal(headers.authorization, "Bearer sk-test")
  assert.deepEqual(usage, [[120, 15]])
})

test("gpt-5.x wire quirks: max_completion_tokens, no temperature", async () => {
  const calls: RecordedCall[] = []
  const provider = new OpenAIChatJudgeProvider({
    chatUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-5.4-nano",
    apiKeys: ["sk-test"],
    maxOutputTokens: 4096,
    maxTokensField: "max_completion_tokens",
    omitTemperature: true,
    fetch: recordingFetch(
      [jsonResponse(chatCompletion('{"verdict": "drift", "reason": "off"}'))],
      calls,
    ),
  })

  await provider.classifyTier1({ goal: "테스트" })
  const body = calls[0].body
  assert.equal(body.max_completion_tokens, 4096)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.temperature, undefined)
})

test("rotates to the next key on 429 and succeeds", async () => {
  const calls: RecordedCall[] = []
  const provider = new OpenAIChatJudgeProvider({
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "upstage/solar-pro-3",
    apiKeys: ["key-1", "key-2"],
    fetch: recordingFetch(
      [
        jsonResponse({ error: "rate limited" }, 429),
        jsonResponse(chatCompletion('{"verdict": "ok", "reason": "fine"}')),
      ],
      calls,
    ),
  })

  const result = await provider.classifyTier1({ goal: "테스트" })
  assert.equal(result.verdict, "OK")
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.authorization, "Bearer key-1")
  assert.equal(calls[1].headers.authorization, "Bearer key-2")
})

test("writer trims, refuses empty output, and skips json plumbing", async () => {
  const calls: RecordedCall[] = []
  const provider = new OpenAIChatJudgeProvider({
    chatUrl: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-flash",
    apiKeys: ["k"],
    writerMaxOutputTokens: 2048,
    fetch: recordingFetch([jsonResponse(chatCompletion("  훈수 한 줄  "))], calls),
  })

  const message = await provider.writeTier2Message({ goal: "g" }, "system prompt")
  assert.equal(message, "훈수 한 줄")
  assert.equal(calls[0].body.max_tokens, 2048)
})

test("length finish_reason surfaces schema failures as output_exhausted", async () => {
  const provider = new OpenAIChatJudgeProvider({
    chatUrl: "https://api.example.com/v1/chat/completions",
    model: "m",
    apiKeys: ["k"],
    maxOutputTokens: 4096,
    fetch: recordingFetch(
      [
        jsonResponse({
          choices: [{ message: { role: "assistant", content: '{"verdict": "truncat' }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 4096 },
        }),
      ],
      [],
    ),
  })

  await assert.rejects(
    provider.classifyTier1({ goal: "g" }),
    (error: { stage?: string }) => error.stage === "output_exhausted",
  )
})

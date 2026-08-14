// Anthropic messages adapter: wire shape (x-api-key + version headers, system field,
// no temperature), text-block extraction, exhaustion, and key rotation.

import assert from "node:assert/strict"
import test from "node:test"

import { ClaudeChatJudgeProvider } from "./claudeChat.ts"
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

function claudeMessage(text: string, stopReason = "end_turn"): unknown {
  return {
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: { input_tokens: 200, output_tokens: 30 },
  }
}

test("Tier 1 sends a canonical messages request and parses the verdict", async () => {
  const calls: RecordedCall[] = []
  const usage: Array<[number, number]> = []
  const provider = new ClaudeChatJudgeProvider({
    chatUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-4-5",
    apiKeys: ["sk-ant-test"],
    maxOutputTokens: 4096,
    fetch: recordingFetch(
      [jsonResponse(claudeMessage('{"verdict": "ok", "reason": "fine"}'))],
      calls,
    ),
    onUsage: (i, o) => void usage.push([i, o]),
  })

  const result = await provider.classifyTier1({ goal: "테스트" })
  assert.equal(result.verdict, "OK")

  const { body, headers } = calls[0]
  assert.equal(body.model, "claude-haiku-4-5")
  assert.equal(body.max_tokens, 4096)
  assert.equal(body.system, TIER1_OLLAMA_SYSTEM_PROMPT)
  assert.equal(body.temperature, undefined) // current Claude models reject sampling params
  const messages = body.messages as Array<{ role: string; content: string }>
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, "user")
  assert.equal(headers["x-api-key"], "sk-ant-test")
  assert.equal(headers["anthropic-version"], "2023-06-01")
  assert.deepEqual(usage, [[200, 30]])
})

test("rotates to the next key on 401 and succeeds", async () => {
  const calls: RecordedCall[] = []
  const provider = new ClaudeChatJudgeProvider({
    chatUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-5",
    apiKeys: ["dead-key", "live-key"],
    fetch: recordingFetch(
      [
        jsonResponse({ error: "auth" }, 401),
        jsonResponse(claudeMessage('{"verdict": "drift", "reason": "off"}')),
      ],
      calls,
    ),
  })

  const result = await provider.classifyTier1({ goal: "테스트" })
  assert.equal(result.verdict, "DRIFT")
  assert.equal(calls[1].headers["x-api-key"], "live-key")
})

test("max_tokens stop_reason surfaces schema failures as output_exhausted", async () => {
  const provider = new ClaudeChatJudgeProvider({
    chatUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-4-5",
    apiKeys: ["k"],
    fetch: recordingFetch(
      [jsonResponse(claudeMessage('{"verdict": "trunc', "max_tokens"))],
      [],
    ),
  })

  await assert.rejects(
    provider.classifyTier1({ goal: "g" }),
    (error: { stage?: string }) => error.stage === "output_exhausted",
  )
})

test("writer extracts the first text block", async () => {
  const provider = new ClaudeChatJudgeProvider({
    chatUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-5",
    apiKeys: ["k"],
    fetch: recordingFetch(
      [
        jsonResponse({
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "  훈수 한 줄  " },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ],
      [],
    ),
  })

  const message = await provider.writeTier2Message({ goal: "g" }, "system")
  assert.equal(message, "훈수 한 줄")
})

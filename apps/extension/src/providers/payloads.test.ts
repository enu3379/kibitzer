import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTier1Payload,
  buildTier2MessagePayload,
  buildTier2ReviewPayload,
  compressRecentTitles,
} from "./payloads.ts"

test("Tier 1 payload contains only minimized configured fields", () => {
  const payload = buildTier1Payload(
    {
      rawText: "국내 여행지 탐색",
      derivedPhrases: ["서울 근교", "당일치기"],
    },
    {
      title: "서울 당일치기",
      urlHost: "example.test",
    },
    [
      { title: "이전 페이지", verdict: "OK" },
      { title: null, verdict: null },
    ],
  )

  assert.deepEqual(payload, {
    goal: "국내 여행지 탐색",
    current: {
      title: "서울 당일치기",
      url_host: "example.test",
    },
    "goal.derived_phrases": ["서울 근교", "당일치기"],
    recent: [{ title: "이전 페이지", verdict: "OK" }],
  })
})

test("recent title compression preserves order and consecutive run lengths", () => {
  assert.deepEqual(
    compressRecentTitles([
      { title: "A", verdict: "DRIFT" },
      { title: "A", verdict: "DRIFT" },
      { title: "B", verdict: "OK" },
      { title: "A", verdict: "DRIFT" },
    ]),
    [
      { title: "A", verdict: "DRIFT", repeat_count: 2 },
      { title: "B", verdict: "OK", repeat_count: 1 },
      { title: "A", verdict: "DRIFT", repeat_count: 1 },
    ],
  )
})

test("Tier 2 review payload cleans excerpts and keeps the trust-boundary shape", () => {
  const payload = buildTier2ReviewPayload(
    { rawText: "논문 읽기" },
    {
      title: "Dictionary",
      urlHost: "example.test",
      verdict: "DRIFT",
      tierReached: 1,
      tier0Score: 0.2,
    },
    [
      { title: "Dictionary", verdict: "DRIFT" },
      { title: "Dictionary", verdict: "DRIFT" },
    ],
    "  a   useful\n definition  ",
    [{ title: "Paper", verdict: "OK", text: "related excerpt" }],
    { mode_clock_seconds: 300 },
    { excerptCharLimit: 12 },
  )

  assert.deepEqual(payload, {
    review_kind: "combined",
    goal: "논문 읽기",
    current: {
      title: "Dictionary",
      url_host: "example.test",
      verdict: "DRIFT",
      tier_reached: 1,
      tier0_score: 0.2,
      page_excerpt: "a useful def",
    },
    recent_titles: [
      { title: "Dictionary", verdict: "DRIFT", repeat_count: 2 },
    ],
    recent_pages: [
      { title: "Paper", verdict: "OK", page_excerpt: "related excerpt" },
    ],
    repeat_signals: { current_title_recent_visits: 2 },
    time_budget: { mode_clock_seconds: 300 },
  })
})

test("Tier 2 message payload maps the TypeScript decision to wire keys", () => {
  assert.deepEqual(
    buildTier2MessagePayload(
      { rawText: "테스트 작성" },
      { title: "Video", urlHost: "example.test" },
      {
        decision: "notify",
        reasonCode: "off_goal",
        basis: "title",
      },
      null,
      { nag_count_today: 1 },
    ),
    {
      goal: "테스트 작성",
      current: { title: "Video", url_host: "example.test" },
      judgment: {
        decision: "notify",
        reason_code: "off_goal",
        basis: "title",
      },
      nagging_context: { nag_count_today: 1 },
    },
  )
})

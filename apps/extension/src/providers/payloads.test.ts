import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSessionSummaryPayload,
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

test("Tier 2 review payload keeps tier_reached=0 — a tier that never ran is 0, not null", () => {
  const payload = buildTier2ReviewPayload(
    { rawText: "논문 읽기" },
    { title: "Dictionary", urlHost: "example.test", verdict: "DRIFT", tierReached: 0, tier0Score: 0.2 },
    [],
    null,
    [],
    null,
  )
  const current = payload.current as Record<string, unknown>
  assert.equal(current.tier_reached, 0)
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

test("session summary payload carries aggregates, the dice, and at most five pages", () => {
  const topPages = [1, 2, 3, 4, 5, 6].map((i) => ({
    title: `T${i}`,
    host: `h${i}.test`,
    minutes: i,
    verdict: i % 2 ? "OK" : "DRIFT",
  }))
  const payload = buildSessionSummaryPayload(
    {
      goalText: "논문 정리",
      sessionMinutes: 87,
      pagesTotal: 12,
      pagesOk: 8,
      okRatio: 8 / 12,
      validMinutes: 54,
      nagCount: 3,
      topPages,
    },
    { focus: "top_page", closing: "question", bonus: true },
    "no_nag",
    { label: "📷 인스타그램", visits: 5 },
  )
  assert.deepEqual(payload, {
    goal: "논문 정리",
    session_minutes: 87,
    pages_total: 12,
    pages_ok: 8,
    ok_ratio: 0.67,
    valid_minutes: 54,
    nag_count: 3,
    top_pages: topPages.slice(0, 5),
    top_drift_host: { label: "📷 인스타그램", visits: 5 },
    focus_hint: "top_page",
    closing_style: "question",
    bonus_allowed: true,
    special_event: "no_nag",
  })
})

test("session summary payload nulls the optional fields without inventing values", () => {
  const payload = buildSessionSummaryPayload(
    {
      goalText: "g",
      sessionMinutes: 1,
      pagesTotal: 0,
      pagesOk: 0,
      okRatio: null,
      validMinutes: 0,
      nagCount: 0,
      topPages: [{ title: null, host: null, minutes: 0, verdict: null }],
    },
    { focus: "ratio", closing: "verdict", bonus: false },
    null,
  )
  assert.equal(payload.ok_ratio, null)
  assert.equal(payload.special_event, null)
  assert.equal(payload.top_drift_host, null) // omitted → null, never invented
  assert.deepEqual(payload.top_pages, [{ title: null, host: null, minutes: 0, verdict: null }])
})

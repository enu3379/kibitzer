import assert from "node:assert/strict"
import test from "node:test"

import { pickSummaryFallback } from "./sessionSummary.ts"
import type { SessionStats } from "./sessionStats.ts"

const statsWith = (over: Partial<SessionStats>): SessionStats => ({
  goalText: "논문 정리",
  sessionMinutes: 87,
  activeMs: 62 * 60_000,
  pagesTotal: 12,
  pagesOk: 8,
  okRatio: 8 / 12,
  validMs: 54 * 60_000,
  nagCount: 3,
  topPage: { title: "어텐션 리뷰", host: "velog.io", ms: 21 * 60_000, verdict: "OK" },
  topPages: [],
  endedAt: 0,
  ...over,
})

test("empty session gets the dedicated line, no numbers", () => {
  const text = pickSummaryFallback(statsWith({ pagesTotal: 0, pagesOk: 0, validMs: 0 }))
  assert.match(text, /판정할 페이지가 없었어요/)
})

test("event lines outrank the generic pool", () => {
  assert.match(pickSummaryFallback(statsWith({ pagesOk: 12 })), /퍼펙트 세션/)
  assert.match(pickSummaryFallback(statsWith({ pagesOk: 0 })), /유효로 판정된 페이지가 없었어요/)
  assert.match(pickSummaryFallback(statsWith({ nagCount: 0 })), /훈수 한 번 없이/)
})

test("the generic pool rotates by the injected rand and embeds the stats", () => {
  const texts = new Set<string>()
  for (const r of [0, 0.3, 0.6, 0.9]) {
    texts.add(pickSummaryFallback(statsWith({}), null, () => r))
  }
  assert.equal(texts.size, 4) // four distinct templates
  for (const text of texts) {
    assert.match(text, /8|12|54분|어텐션 리뷰/) // stats-driven, not canned filler
  }
})

test("a repeat time-sink adds a drift-flavored fallback variant", () => {
  const withDrift = pickSummaryFallback(statsWith({}), { label: "📷 인스타그램", visits: 5 }, () => 0.999)
  assert.match(withDrift, /📷 인스타그램에는 5번/)
})

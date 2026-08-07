import assert from "node:assert/strict"
import test from "node:test"
import { HEALTH_TTL_MS, type TierHealth } from "./providerHealth.ts"
import {
  buildProviderWarn,
  formatAgo,
  providerAlertBody,
  providerAlertLevel,
} from "./providerHealthView.ts"

const NOW = 1_754_000_000_000

const err = (over: Partial<TierHealth> = {}): TierHealth => ({
  ok: false,
  kind: "auth",
  message: "API 키 인증 실패 (키 확인 필요)",
  ts: NOW,
  ...over,
})
const okRecord = (): TierHealth => ({ ok: true, kind: "", message: "", ts: NOW })

const KEYED = { tier1: false, tier2: false }

// --- {시간} formatting --------------------------------------------------------------

test("formatAgo: 조금전 / n분전 / n시간 전 boundaries", () => {
  assert.equal(formatAgo(NOW, NOW), "조금전")
  assert.equal(formatAgo(NOW - 59_999, NOW), "조금전")
  assert.equal(formatAgo(NOW - 60_000, NOW), "1분전")
  assert.equal(formatAgo(NOW - 59 * 60_000 - 59_000, NOW), "59분전")
  assert.equal(formatAgo(NOW - 60 * 60_000, NOW), "1시간 전")
  assert.equal(formatAgo(NOW - 23 * 3_600_000 - 3_599_000, NOW), "23시간 전")
  assert.equal(formatAgo(NOW - HEALTH_TTL_MS, NOW), null, "24h+ ⇒ expired, no line at all")
})

// --- fact lines ---------------------------------------------------------------------

test("fact lines: one per erring tier, tier1 first, exact copy and tones", () => {
  const model = buildProviderWarn(
    { tier1: err({ message: "요청 한도 초과 (429)", ts: NOW - 5 * 60_000 }), tier2: err({ stage: "judge", ts: NOW - 2 * 3_600_000 }) },
    KEYED,
    NOW,
  )
  assert.equal(model.facts.length, 2)
  assert.deepEqual(model.facts[0], { text: "⚠ 빠른 판정 오류(5분전): 요청 한도 초과 (429)", tone: "amber" })
  assert.deepEqual(model.facts[1], { text: "⚠ 정밀 판정 오류(2시간 전): API 키 인증 실패 (키 확인 필요)", tone: "red" })
})

test("a tier2 writer error gets its own fact-line label", () => {
  const model = buildProviderWarn({ tier1: null, tier2: err({ stage: "writer" }) }, KEYED, NOW)
  assert.deepEqual(model.facts, [
    { text: "⚠ 훈수 문구 생성 오류(조금전): API 키 인증 실패 (키 확인 필요)", tone: "red" },
  ])
})

test("no live error ⇒ the whole block stays hidden — ok records and keyless routes alike", () => {
  assert.deepEqual(buildProviderWarn({ tier1: null, tier2: null }, KEYED, NOW), { facts: [], consequence: null })
  assert.deepEqual(buildProviderWarn({ tier1: okRecord(), tier2: okRecord() }, KEYED, NOW), { facts: [], consequence: null })
  // Keyless is deliberate config, not an error — alone it must show nothing.
  assert.deepEqual(
    buildProviderWarn({ tier1: null, tier2: null }, { tier1: true, tier2: true }, NOW),
    { facts: [], consequence: null },
  )
})

test("an expired error record is invisible to the popup model too", () => {
  const stale = err({ ts: NOW - HEALTH_TTL_MS })
  assert.deepEqual(buildProviderWarn({ tier1: stale, tier2: null }, KEYED, NOW), { facts: [], consequence: null })
  assert.deepEqual(
    buildProviderWarn({ tier1: null, tier2: { ...stale, stage: "judge" } }, KEYED, NOW),
    { facts: [], consequence: null },
  )
})

// --- the consequence-line matrix (every row of the table) ---------------------------

test("tier1 error only; tier2 keyed & healthy", () => {
  const model = buildProviderWarn({ tier1: err(), tier2: null }, KEYED, NOW)
  assert.equal(model.consequence, "멀쩡한 페이지에서 훈수를 받을 수도 있어요")
})

test("tier2 judge error; tier1 keyed & healthy", () => {
  const model = buildProviderWarn({ tier1: null, tier2: err({ stage: "judge" }) }, KEYED, NOW)
  assert.equal(model.consequence, "내용 확인 없이 준비된 문구로만 훈수해요")
})

test("both 판정 불가: tier1 error + tier2 judge error", () => {
  const model = buildProviderWarn({ tier1: err(), tier2: err({ stage: "judge" }) }, KEYED, NOW)
  assert.equal(model.consequence, "LLM을 사용하지 않고 판정하고, 준비된 문구로만 훈수해요")
})

test("both 판정 불가: tier1 error + tier2 keyless (keyless participates, unreported)", () => {
  const model = buildProviderWarn({ tier1: err(), tier2: null }, { tier1: false, tier2: true }, NOW)
  assert.equal(model.facts.length, 1, "the keyless tier gets no fact line")
  assert.equal(model.consequence, "LLM을 사용하지 않고 판정하고, 준비된 문구로만 훈수해요")
})

test("both 판정 불가: tier1 keyless + tier2 judge error", () => {
  const model = buildProviderWarn(
    { tier1: null, tier2: err({ stage: "judge" }) },
    { tier1: true, tier2: false },
    NOW,
  )
  assert.equal(model.facts.length, 1)
  assert.equal(model.consequence, "LLM을 사용하지 않고 판정하고, 준비된 문구로만 훈수해요")
})

test("tier2 writer error only; tier1 keyed & healthy", () => {
  const model = buildProviderWarn({ tier1: null, tier2: err({ stage: "writer" }) }, KEYED, NOW)
  assert.equal(model.consequence, "훈수 문구 생성에 실패해 준비된 문구로 대체했어요")
})

test("tier2 writer error with tier1 keyless — writer tail, keyless not reported", () => {
  const model = buildProviderWarn(
    { tier1: null, tier2: err({ stage: "writer" }) },
    { tier1: true, tier2: false },
    NOW,
  )
  assert.equal(model.facts.length, 1)
  assert.equal(model.consequence, "훈수 문구 생성에 실패해 준비된 문구로 대체했어요")
})

test("tier1 error + tier2 writer error", () => {
  const model = buildProviderWarn({ tier1: err(), tier2: err({ stage: "writer" }) }, KEYED, NOW)
  assert.equal(model.consequence, "멀쩡한 페이지에서 훈수를 받을 수도 있어요. 문구는 준비된 문구로 대체했어요")
})

// --- toolbar mark priority ----------------------------------------------------------

test("alert level: tier2 error red, tier1-only amber, red wins, ok/absent off", () => {
  assert.equal(providerAlertLevel({ tier1: null, tier2: err({ stage: "judge" }) }), "red")
  assert.equal(providerAlertLevel({ tier1: err(), tier2: null }), "amber")
  assert.equal(providerAlertLevel({ tier1: err(), tier2: err({ stage: "writer" }) }), "red")
  assert.equal(providerAlertLevel({ tier1: okRecord(), tier2: okRecord() }), null)
  assert.equal(providerAlertLevel({ tier1: null, tier2: null }), null)
})

// --- OS notification body variants --------------------------------------------------

test("OS body: Tier 1 keyed and healthy", () => {
  assert.equal(
    providerAlertBody("Gemini", "요청 한도 초과 (429)", { keyless: false, hasLiveError: false }),
    "정밀 판정(Gemini) 오류: 요청 한도 초과 (429) · 빠른 판정은 정상 동작 중이에요. 정밀 판정 없이 준비된 문구로 훈수해요. 누르면 설정이 열립니다.",
  )
})

test("OS body: Tier 1 keyed with a live error", () => {
  assert.equal(
    providerAlertBody("Ollama Cloud", "응답 시간 초과", { keyless: false, hasLiveError: true }),
    "정밀 판정(Ollama Cloud) 오류: 응답 시간 초과 · 빠른 판정에도 오류가 있어 지금은 제목 유사도로만 판정하고, 준비된 문구로 훈수해요. 누르면 설정이 열립니다.",
  )
})

test("OS body: Tier 1 route keyless", () => {
  assert.equal(
    providerAlertBody("OpenRouter", "API 키 인증 실패 (키 확인 필요)", { keyless: true, hasLiveError: false }),
    "정밀 판정(OpenRouter) 오류: API 키 인증 실패 (키 확인 필요) · 지금은 제목 유사도로만 판정하고, 준비된 문구로 훈수해요. 누르면 설정이 열립니다.",
  )
})

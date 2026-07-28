import assert from "node:assert/strict"
import test from "node:test"

import { clampSentences, fillTemplate, pickFallback, PERSONAS, PERSONA_ORDER } from "./personas.ts"

test("clampSentences keeps at most N sentences", () => {
  assert.equal(clampSentences("첫 문장. 둘째 문장. 셋째 문장.", 2), "첫 문장. 둘째 문장.")
  assert.equal(clampSentences("한 문장뿐.", 2), "한 문장뿐.")
})

test("clampSentences does not split domains or decimals (identifier-embedded dots)", () => {
  assert.equal(clampSentences("youtube.com 좋네요. 이력서엔 없습니다.", 1), "youtube.com 좋네요.")
  assert.equal(clampSentences("3.6점 입니다. 좋아요.", 1), "3.6점 입니다.")
})

test("clampSentences treats stacked marks as one boundary", () => {
  assert.equal(clampSentences("안녕!! 반가워요.", 1), "안녕!!")
  assert.equal(clampSentences("세이프!? 다음.", 1), "세이프!?")
})

test("clampSentences normalizes whitespace and handles max<=0", () => {
  assert.equal(clampSentences("  a   b  c  ", 0), "a b c")
  assert.equal(clampSentences("한\n문장.\t둘째.", 1), "한 문장.")
})

test("fillTemplate fixes a particle that disagrees with the substituted value", () => {
  assert.equal(
    fillTemplate("{goal}이 안 보인다는 점만 빼면요.", { goal: "네이버 뉴스보기" }),
    "네이버 뉴스보기가 안 보인다는 점만 빼면요.",
  )
  assert.equal(
    fillTemplate("이 속도면 {goal}은 다음 계절에나 뵙겠어요.", { goal: "발표자료" }),
    "이 속도면 발표자료는 다음 계절에나 뵙겠어요.",
  )
  assert.equal(
    fillTemplate("근데 오늘 경기는 {goal}이잖아요.", { goal: "발표자료" }),
    "근데 오늘 경기는 발표자료잖아요.",
  )
})

test("fillTemplate keeps a particle that already agrees", () => {
  assert.equal(
    fillTemplate("{goal}이 안 보인다는 점만 빼면요.", { goal: "리포트 작성" }),
    "리포트 작성이 안 보인다는 점만 빼면요.",
  )
  assert.equal(fillTemplate("{goal}로 회귀했다.", { goal: "자료 조사" }), "자료 조사로 회귀했다.")
})

test("fillTemplate resolves particles across closing quotes", () => {
  assert.equal(
    fillTemplate("'{title}'이라. 확실히 이것도 하나의 방법이긴 합니다.", { title: "나 혼자 산다" }),
    "'나 혼자 산다'라. 확실히 이것도 하나의 방법이긴 합니다.",
  )
  assert.equal(
    fillTemplate("'{title}'이 오늘 {nag_count}번째 코스네요.", { title: "쇼핑 특가", nag_count: "3" }),
    "'쇼핑 특가'가 오늘 3번째 코스네요.",
  )
})

test("fillTemplate resolves hedged spellings and the copular 야", () => {
  assert.equal(
    fillTemplate("{host}을(를) 상습 이탈 구간으로 지정.", { host: "youtube.com" }),
    "youtube.com을 상습 이탈 구간으로 지정.",
  )
  assert.equal(
    fillTemplate("{goal}(으)로 회항하셨습니다.", { goal: "보고서 작성" }),
    "보고서 작성으로 회항하셨습니다.",
  )
  assert.equal(fillTemplate("또 {host}야?", { host: "youtube.com" }), "또 youtube.com이야?")
  assert.equal(fillTemplate("또 {host}야?", { host: "namu.wiki" }), "또 namu.wiki야?")
})

test("fillTemplate leaves invariant particles and unknown placeholders as written", () => {
  assert.equal(fillTemplate("{goal}만 빼고 전부 진행 중입니다.", { goal: "숙제" }), "숙제만 빼고 전부 진행 중입니다.")
  assert.equal(fillTemplate("오늘 {nag_count}번째 관전평입니다.", { nag_count: "3" }), "오늘 3번째 관전평입니다.")
  assert.equal(fillTemplate("{goal}이 목표다: {unknown}", { goal: "?!" }), "?!이 목표다: {unknown}")
})

test("pickFallback delivers josa-corrected messages end-to-end", () => {
  const dry = PERSONAS.dry_kibitzer
  // 5th nag → template index 4: "훌륭하진 않지만 끔찍하지도 않습니다. {goal}이 안 보인다는 점만 빼면요."
  const message = pickFallback(dry, 5, { goal: "네이버 뉴스보기", title: "웹툰", host: "comic.naver.com" })
  assert.ok(message?.includes("네이버 뉴스보기가 안 보인다"), message ?? "(null)")
})

test("every persona is well-formed with fallback + celebrate templates", () => {
  assert.equal(PERSONA_ORDER.length, 10)
  for (const key of PERSONA_ORDER) {
    const p = PERSONAS[key]
    assert.ok(p, `missing persona ${key}`)
    assert.ok(p.name.length > 0)
    assert.ok(p.stylePrompt.length > 0)
    assert.ok(p.fallbackTemplates.length > 0)
    assert.ok(p.celebrateTemplates.length > 0)
  }
})

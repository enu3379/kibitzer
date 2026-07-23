import assert from "node:assert/strict"
import test from "node:test"

import { clampSentences, PERSONAS, PERSONA_ORDER } from "./personas.ts"

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

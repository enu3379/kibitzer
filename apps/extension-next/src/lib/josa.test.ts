import assert from "node:assert/strict"
import test from "node:test"

import { resolveJosa, wordEnding } from "./josa.ts"

test("wordEnding reads the final Hangul syllable", () => {
  assert.deepEqual(wordEnding("리포트 작성"), { batchim: true, rieul: false })
  assert.deepEqual(wordEnding("네이버 뉴스보기"), { batchim: false, rieul: false })
  assert.deepEqual(wordEnding("서울"), { batchim: true, rieul: true })
})

test("wordEnding skips trailing punctuation and quotes", () => {
  assert.deepEqual(wordEnding("'뉴스 보기'"), { batchim: false, rieul: false })
  assert.deepEqual(wordEnding("리포트 작성!!"), { batchim: true, rieul: false })
})

test("wordEnding maps digits by their Korean readings", () => {
  assert.equal(wordEnding("아이폰 15")?.batchim, false) // 오
  assert.equal(wordEnding("시즌 3")?.batchim, true) // 삼
  assert.deepEqual(wordEnding("21"), { batchim: true, rieul: true }) // 일
})

test("wordEnding maps Latin letters by their Korean letter names", () => {
  assert.equal(wordEnding("youtube.com")?.batchim, true) // 엠
  assert.equal(wordEnding("namu.wiki")?.batchim, false) // 아이
  assert.deepEqual(wordEnding("gmail"), { batchim: true, rieul: true }) // 엘
})

test("wordEnding is null without a sound-bearing char", () => {
  assert.equal(wordEnding(""), null)
  assert.equal(wordEnding("?!…"), null)
})

test("resolveJosa picks the agreeing allomorph for plain pairs", () => {
  assert.deepEqual(resolveJosa("뉴스보기", "이 안 보인다"), { particle: "가", consumed: 1 })
  assert.deepEqual(resolveJosa("리포트 작성", "이 안 보인다"), { particle: "이", consumed: 1 })
  assert.deepEqual(resolveJosa("발표자료", "은 밖에서"), { particle: "는", consumed: 1 })
  assert.deepEqual(resolveJosa("youtube.com", "을(를) 상습"), { particle: "을", consumed: 4 })
})

test("resolveJosa handles 로/으로 with the ㄹ-batchim exception", () => {
  assert.deepEqual(resolveJosa("보고서 작성", "로 돌아왔습니다"), { particle: "으로", consumed: 1 })
  assert.deepEqual(resolveJosa("자료 조사", "로 돌아왔습니다"), { particle: "로", consumed: 1 })
  assert.deepEqual(resolveJosa("서울", "(으)로 회항"), { particle: "로", consumed: 4 })
  assert.deepEqual(resolveJosa("보고서 작성", "(으)로 회항"), { particle: "으로", consumed: 4 })
})

test("resolveJosa drops the copular 이 after a vowel ending", () => {
  assert.deepEqual(resolveJosa("발표자료", "이잖아요"), { particle: "잖", consumed: 2 })
  assert.deepEqual(resolveJosa("나 혼자 산다", "이라, 좋습니다"), { particle: "라", consumed: 2 })
  assert.deepEqual(resolveJosa("숙제", "이랑 무슨"), { particle: "랑", consumed: 2 })
  assert.deepEqual(resolveJosa("youtube.com", "야? 딱히"), { particle: "이야", consumed: 1 })
})

test("resolveJosa leaves non-particles and undeterminable endings alone", () => {
  assert.equal(resolveJosa("3", "번째 관전평"), null)
  assert.equal(resolveJosa("발표자료", "만 빼고"), null)
  assert.equal(resolveJosa("?!", "이 안 보인다"), null)
})

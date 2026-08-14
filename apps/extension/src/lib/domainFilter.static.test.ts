// The static privacy gate (configs/sensitive_domains.json → shouldDropUrl) was only ever
// exercised through one e2e case; these pin its matching semantics — exact-host, subdomain
// suffix, host+path prefix, keyword substring, fail-closed — against the Korean-expanded
// list shipped for the beta (banking/cards/securities/health/government/webmail).

import assert from "node:assert/strict"
import test from "node:test"
import { shouldDropUrl } from "./domainFilter.ts"

test("Korean financial hosts are blocked, including subdomains", () => {
  assert.ok(shouldDropUrl("https://kbstar.com/"))
  assert.ok(shouldDropUrl("https://obank.kbstar.com/quics"), "subdomain suffix match")
  assert.ok(shouldDropUrl("https://www.shinhan.com/"))
  assert.ok(shouldDropUrl("https://toss.im/"))
  assert.ok(shouldDropUrl("https://upbit.com/exchange"))
  // Already covered by the "bank" keyword, not the host list — must stay blocked.
  assert.ok(shouldDropUrl("https://kakaobank.com/"))
  assert.ok(shouldDropUrl("https://tossbank.com/"))
})

test("government and health suffixes match whole TLD chains, not lookalikes", () => {
  assert.ok(shouldDropUrl("https://hometax.go.kr/"), "*.go.kr")
  assert.ok(shouldDropUrl("https://www.gov.kr/portal"), "*.gov.kr")
  assert.ok(shouldDropUrl("https://www.nhis.or.kr/"))
  // endsWith is anchored at a dot: a host merely ENDING in "go.kr" must not match.
  assert.ok(!shouldDropUrl("https://logo.kr/"), "no substring false positive on the suffix")
})

test("Korean webmail and account hosts are blocked; their portals are not", () => {
  assert.ok(shouldDropUrl("https://mail.naver.com/"))
  assert.ok(shouldDropUrl("https://nid.naver.com/nidlogin"))
  assert.ok(shouldDropUrl("https://accounts.kakao.com/"))
  assert.ok(!shouldDropUrl("https://www.naver.com/"), "the portal itself stays observable")
  assert.ok(!shouldDropUrl("https://www.kakao.com/"))
  assert.ok(!shouldDropUrl("https://www.daum.net/"))
})

test("keywords match as host substrings", () => {
  assert.ok(shouldDropUrl("https://www.samsunghospital.com/"), "hospital")
  assert.ok(shouldDropUrl("https://auth.example.com/"), "auth")
  assert.ok(!shouldDropUrl("https://example.com/hospital-drama-review"), "path is not keyword-matched")
})

test("host+path entries block only under the path; the gate fails closed", () => {
  assert.ok(shouldDropUrl("https://github.com/settings/keys"))
  assert.ok(!shouldDropUrl("https://github.com/enu3379/kibitzer"))
  assert.ok(shouldDropUrl("not a url"), "malformed URL drops")
})

import assert from "node:assert/strict"
import test from "node:test"

import { friendlyHost, friendlyLabel } from "./friendlyHost.ts"

test("known hosts resolve to an emoji + Korean name, including www/m subdomains", () => {
  assert.deepEqual(friendlyHost("instagram.com"), { emoji: "📷", name: "인스타그램" })
  assert.deepEqual(friendlyHost("www.instagram.com"), { emoji: "📷", name: "인스타그램" })
  assert.deepEqual(friendlyHost("m.youtube.com"), { emoji: "▶️", name: "유튜브" })
  assert.equal(friendlyHost("x.com").name, "X")
  assert.equal(friendlyHost("twitter.com").name, "X") // alias folds to the same name
})

test("unknown hosts fall back to the bare host with no emoji", () => {
  assert.deepEqual(friendlyHost("velog.io"), { emoji: "", name: "velog.io" })
  assert.deepEqual(friendlyHost("www.velog.io"), { emoji: "", name: "velog.io" })
  assert.equal(friendlyHost("").name, "알 수 없는 사이트")
})

test("friendlyLabel joins emoji + name, or just the host when unknown", () => {
  assert.equal(friendlyLabel("instagram.com"), "📷 인스타그램")
  assert.equal(friendlyLabel("velog.io"), "velog.io")
})

import assert from "node:assert/strict"
import test from "node:test"

import { hostOf, pageKeyOf } from "./url.ts"

test("pageKeyOf distinguishes pages that differ only by query (B4 collision fix)", () => {
  const a = pageKeyOf("https://youtube.com/watch?v=A")
  const b = pageKeyOf("https://youtube.com/watch?v=B")
  assert.ok(a && b && a !== b, "?v=A and ?v=B must not collide")
})

test("pageKeyOf keeps the raw path out of the key (PII hashed)", () => {
  const key = pageKeyOf("https://site.test/user/123/secret-doc")
  assert.ok(key, "http(s) URL yields a key")
  assert.ok(!key!.includes("secret-doc") && !key!.includes("/user/123"), `raw path leaked: ${key}`)
  assert.ok(key!.startsWith("site.test#"), "host stays visible, path folded into a hash")
})

test("pageKeyOf is deterministic and rejects non-http(s)", () => {
  assert.equal(pageKeyOf("https://a.test/x"), pageKeyOf("https://a.test/x"))
  assert.equal(pageKeyOf("https://x.com/home"), pageKeyOf("https://x.com/home"))
  assert.equal(pageKeyOf("chrome://extensions"), null)
  assert.equal(pageKeyOf("not a url"), null)
})

test("hostOf returns the hostname", () => {
  assert.equal(hostOf("https://a.test:8080/x?y=1"), "a.test")
})

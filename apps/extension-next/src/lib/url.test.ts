import assert from "node:assert/strict"
import test from "node:test"

import { describeObservableUrl, hostOf, pageKeyOf } from "./url.ts"

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

test("local PDF descriptors are opaque, stable, and use a non-path host label", () => {
  const raw = "file:///C:/Users/alice/Private%20Papers/secret-study.PDF"
  const descriptor = describeObservableUrl(raw)
  assert.ok(descriptor)
  assert.equal(descriptor.kind, "local_pdf")
  assert.equal(descriptor.urlHost, "local-pdf")
  assert.ok(descriptor.pageKey.startsWith("local-pdf#"))
  assert.ok(!descriptor.pageKey.includes("alice") && !descriptor.pageKey.includes("secret-study"))
  assert.equal(hostOf(raw), "local-pdf")
  assert.equal(pageKeyOf(`${raw}#page=9`), descriptor.pageKey, "PDF page fragments keep one identity")
  assert.notEqual(
    pageKeyOf("file://server-a/share/paper.pdf"),
    pageKeyOf("file://server-b/share/paper.pdf"),
    "opaque identity includes the UNC authority without exposing it",
  )
})

test("non-PDF local files remain unobservable", () => {
  assert.equal(describeObservableUrl("file:///C:/Users/alice/notes.html"), null)
  assert.equal(describeObservableUrl("file:///C:/Users/alice/folder/"), null)
})

test("hostOf returns the hostname", () => {
  assert.equal(hostOf("https://a.test:8080/x?y=1"), "a.test")
})

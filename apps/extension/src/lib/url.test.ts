import assert from "node:assert/strict"
import test from "node:test"

import { describeObservableUrl } from "./url.ts"

const keyOf = (url: string): string | null => describeObservableUrl(url)?.pageKey ?? null
const hostOf = (url: string): string => describeObservableUrl(url)?.urlHost ?? ""

test("page keys distinguish pages that differ only by query (B4 collision fix)", () => {
  const a = keyOf("https://youtube.com/watch?v=A")
  const b = keyOf("https://youtube.com/watch?v=B")
  assert.ok(a && b && a !== b, "?v=A and ?v=B must not collide")
})

test("page keys keep the raw path out of the key (PII hashed)", () => {
  const key = keyOf("https://site.test/user/123/secret-doc")
  assert.ok(key, "http(s) URL yields a key")
  assert.ok(!key!.includes("secret-doc") && !key!.includes("/user/123"), `raw path leaked: ${key}`)
  assert.ok(key!.startsWith("site.test#"), "host stays visible, path folded into a hash")
})

test("page keys are deterministic and reject non-http(s)", () => {
  assert.equal(keyOf("https://a.test/x"), keyOf("https://a.test/x"))
  assert.equal(keyOf("https://x.com/home"), keyOf("https://x.com/home"))
  assert.equal(describeObservableUrl("chrome://extensions"), null)
  assert.equal(describeObservableUrl("not a url"), null)
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
  assert.equal(keyOf(`${raw}#page=9`), descriptor.pageKey, "PDF page fragments keep one identity")
  assert.notEqual(
    keyOf("file://server-a/share/paper.pdf"),
    keyOf("file://server-b/share/paper.pdf"),
    "opaque identity includes the UNC authority without exposing it",
  )
})

test("non-PDF local files remain unobservable", () => {
  assert.equal(describeObservableUrl("file:///C:/Users/alice/notes.html"), null)
  assert.equal(describeObservableUrl("file:///C:/Users/alice/folder/"), null)
})

test("web descriptors expose the bare hostname", () => {
  assert.equal(hostOf("https://a.test:8080/x?y=1"), "a.test")
})

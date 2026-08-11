import assert from "node:assert/strict"
import test from "node:test"

import { expectDownload, takeExpectedFilename } from "./downloadName.ts"

test("an announced download is renamed once", () => {
  const url = "data:text/plain;charset=utf-8,hello%20world"
  expectDownload(url, "kibitzer-debug.log")

  assert.equal(takeExpectedFilename(url), "kibitzer-debug.log")
  // Consumed: a later download of the same content must not inherit the name.
  assert.equal(takeExpectedFilename(url), undefined)
})

test("downloads we did not start are left alone", () => {
  expectDownload("data:text/plain;charset=utf-8,ours", "kibitzer-debug.log")

  assert.equal(takeExpectedFilename("https://example.com/report.pdf"), undefined)
})

test("the two exports do not claim each other's name", () => {
  const log = `data:text/plain;charset=utf-8,${encodeURIComponent("21:49:56  observe")}`
  const events = `data:application/json;charset=utf-8,${encodeURIComponent('{"ts":1,"type":"goal"}')}`
  expectDownload(log, "kibitzer-debug.log")
  expectDownload(events, "kibitzer-events.jsonl")

  assert.equal(takeExpectedFilename(events), "kibitzer-events.jsonl")
  assert.equal(takeExpectedFilename(log), "kibitzer-debug.log")
})

test("a DownloadItem url truncated past the prefix still matches", () => {
  const body = encodeURIComponent("x".repeat(500))
  const url = `data:application/json;charset=utf-8,${body}`
  expectDownload(url, "kibitzer-events.jsonl")

  assert.equal(takeExpectedFilename(url.slice(0, 48)), "kibitzer-events.jsonl")
})

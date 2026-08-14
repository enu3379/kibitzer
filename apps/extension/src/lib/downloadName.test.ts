import assert from "node:assert/strict"
import test from "node:test"

import { expectDownload, EXPORT_MIME, takeExpectedFilename } from "./downloadName.ts"

const dataUrl = (body: string): string => `data:${EXPORT_MIME};charset=utf-8,${encodeURIComponent(body)}`

test("an announced download is renamed once", () => {
  const url = dataUrl("hello world")
  expectDownload(url, "kibitzer-debug.log")

  assert.equal(takeExpectedFilename(url), "kibitzer-debug.log")
  // Consumed: a later download of the same content must not inherit the name.
  assert.equal(takeExpectedFilename(url), undefined)
})

test("downloads we did not start are left alone", () => {
  expectDownload(dataUrl("ours"), "kibitzer-debug.log")

  assert.equal(takeExpectedFilename("https://example.com/report.pdf"), undefined)
  takeExpectedFilename(dataUrl("ours"))
})

test("the two exports do not claim each other's name", () => {
  // Both exports declare the same MIME type, so the URLs differ only in their body.
  const log = dataUrl("21:49:56  observe github.com")
  const events = dataUrl('{"ts":1,"type":"goal"}')
  expectDownload(log, "kibitzer-debug.log")
  expectDownload(events, "kibitzer-events.jsonl")

  assert.equal(takeExpectedFilename(events), "kibitzer-events.jsonl")
  assert.equal(takeExpectedFilename(log), "kibitzer-debug.log")
})

test("a DownloadItem url truncated by Chrome still matches", () => {
  const url = dataUrl("x".repeat(500))
  expectDownload(url, "kibitzer-events.jsonl")

  assert.equal(takeExpectedFilename(url.slice(0, 120)), "kibitzer-events.jsonl")
})

test("announcements for downloads that never start cannot pile up", () => {
  for (let i = 0; i < 20; i += 1) expectDownload(dataUrl(`orphan ${i}`), "kibitzer-debug.log")

  // The oldest are evicted; the most recent announcement still works.
  assert.equal(takeExpectedFilename(dataUrl("orphan 0")), undefined)
  assert.equal(takeExpectedFilename(dataUrl("orphan 19")), "kibitzer-debug.log")
})

test("the export MIME type has no preferred extension to swap ours for", () => {
  // text/plain forces .txt and application/json forces .customization on Windows.
  assert.equal(EXPORT_MIME, "application/octet-stream")
})

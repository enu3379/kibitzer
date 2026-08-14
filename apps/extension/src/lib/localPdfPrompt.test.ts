import assert from "node:assert/strict"
import test from "node:test"

import {
  LOCAL_PDF_PROMPT_CONTENT_HEIGHT,
  LOCAL_PDF_PROMPT_DELAY_MS,
  LOCAL_PDF_PROMPT_HEIGHT,
  LOCAL_PDF_PROMPT_WIDTH,
  localPdfPromptPosition,
} from "./localPdfPrompt.ts"

test("waits one second before opening the local-PDF prompt", () => {
  assert.equal(LOCAL_PDF_PROMPT_DELAY_MS, 1000)
})

test("keeps the reviewed content height while allowing for Chrome's native frame", () => {
  assert.equal(LOCAL_PDF_PROMPT_CONTENT_HEIGHT, 250)
  assert.equal(LOCAL_PDF_PROMPT_HEIGHT, 280)
})

test("positions the opt-in popup at the browser window's bottom-right", () => {
  assert.deepEqual(
    localPdfPromptPosition({ left: 100, top: 40, width: 1400, height: 900 }),
    { left: 100 + 1400 - LOCAL_PDF_PROMPT_WIDTH - 18, top: 40 + 900 - LOCAL_PDF_PROMPT_HEIGHT - 18 },
  )
})

test("omits positioning when the window manager does not expose bounds", () => {
  assert.deepEqual(localPdfPromptPosition({ left: undefined, top: 0, width: 1200, height: 800 }), {})
})

test("keeps a popup on the browser's negative-coordinate monitor", () => {
  assert.deepEqual(
    localPdfPromptPosition({ left: -1600, top: -120, width: 1200, height: 900 }),
    { left: -798, top: 482 },
  )
})

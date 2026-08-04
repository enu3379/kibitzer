import assert from "node:assert/strict"
import test from "node:test"

import { safeShouldContinue } from "./tier12.ts"

test("safeShouldContinue preserves a successful policy result", async () => {
  assert.equal(await safeShouldContinue(async () => true), true)
  assert.equal(await safeShouldContinue(async () => false), false)
})

test("safeShouldContinue treats a failed policy read as cancellation", async () => {
  assert.equal(
    await safeShouldContinue(async () => {
      throw new Error("extension context invalidated")
    }),
    false,
  )
})

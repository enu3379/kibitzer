import assert from "node:assert/strict"
import test from "node:test"

import { tokenMatchesPending, type Tier2Token } from "./tier2Token.ts"
import type { PendingTier2 } from "../core/gauge/types.ts"

const token: Tier2Token = { pageKey: "site/a", reason: "promotion", requestId: 7, epoch: 3 }
const pending = (over: Partial<PendingTier2> = {}): PendingTier2 => ({
  reason: "promotion",
  tier: 1,
  pageKey: "site/a",
  requestedAt: 100,
  requestId: 7,
  ...over,
})

test("matches only the exact request instance (by requestId)", () => {
  assert.equal(tokenMatchesPending(token, pending()), true)
})

test("an old job (R1) does NOT match a newer request (R2) with the SAME page/reason/requestedAt", () => {
  // The closure-v2 flaw: R2 opened in the same millisecond had an identical requestedAt, so
  // page+reason+requestedAt matched and R1 could cancel R2. The opaque requestId separates them.
  assert.equal(tokenMatchesPending(token, pending({ requestId: 8, requestedAt: 100 })), false)
})

test("does not match a null slot", () => {
  assert.equal(tokenMatchesPending(token, null), false)
})

import assert from "node:assert/strict"
import test from "node:test"

import { tokenMatchesPending, type Tier2Token } from "./tier2Token.ts"
import type { PendingTier2 } from "../core/gauge/types.ts"

const token: Tier2Token = { pageKey: "site/a", reason: "promotion", requestedAt: 100, epoch: 3 }
const pending = (over: Partial<PendingTier2> = {}): PendingTier2 => ({
  reason: "promotion",
  tier: 1,
  pageKey: "site/a",
  requestedAt: 100,
  ...over,
})

test("matches only the exact request instance", () => {
  assert.equal(tokenMatchesPending(token, pending()), true)
})

test("an old job (R1) does not match a newer same-page/reason request (R2)", () => {
  // R2 replaced the slot with a later requestedAt — R1's token must not apply/cancel it.
  assert.equal(tokenMatchesPending(token, pending({ requestedAt: 200 })), false)
})

test("does not match a null / different page / different reason slot", () => {
  assert.equal(tokenMatchesPending(token, null), false)
  assert.equal(tokenMatchesPending(token, pending({ pageKey: "site/b" })), false)
  assert.equal(tokenMatchesPending(token, pending({ reason: "s_zero" })), false)
})

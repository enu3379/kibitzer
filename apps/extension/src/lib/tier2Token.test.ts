import assert from "node:assert/strict"
import test from "node:test"

import { tokenMatchesPending, tokenPageStillActive, type Tier2Token } from "./tier2Token.ts"
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

// --- tokenPageStillActive -------------------------------------------------------------

test("still active while both the gauge and the record name this request's page", () => {
  assert.equal(tokenPageStillActive(token, "site/a", "site/a"), true)
})

test("NOT active the moment the user leaves — the gauge moves on while the record lags", () => {
  // The regression this predicate exists for. Leaving a page emits a `neutral` transition that
  // settles the page just left (its S=0 gate can open a Tier-2 request naming it) and points the
  // gauge at the new page. The active-page record still names the OLD page — it is only rewritten
  // once the new page survives its dwell and is judged. A pre-gate reading the record alone saw a
  // match and spent a judge call on a page the user had already left.
  assert.equal(tokenPageStillActive(token, "site/b", "site/a"), false)
})

test("NOT active once the user has moved on entirely (both sources on the new page)", () => {
  assert.equal(tokenPageStillActive(token, "site/b", "site/b"), false)
})

test("a null gauge page or a missing active-page record is never a match", () => {
  assert.equal(tokenPageStillActive(token, null, "site/a"), false)
  assert.equal(tokenPageStillActive(token, "site/a", null), false)
  assert.equal(tokenPageStillActive(token, null, null), false)
})

// Identity of one Tier-2 request instance, carried end-to-end (enqueue → durable job →
// guarded apply) so an old job can never apply to — or cancel — a newer same-page/reason
// request, or one from a different session.

import type { PendingTier2, Tier2Reason } from "../core/gauge/types.ts"

export interface Tier2Token {
  pageKey: string
  reason: Tier2Reason
  // The opaque, unique id of the pending slot this request opened — the sole identity check
  // (page + reason are kept for readability/logging). requestedAt would collide for two
  // same-millisecond requests; requestId never does.
  requestId: number
  // Durable goal epoch — used by the apply guard to also require the same session (a
  // clear+redeclare repeats revision 0 but never an epoch).
  epoch: number
}

/** True iff the live pending slot is still this exact request instance (by requestId). */
export function tokenMatchesPending(token: Tier2Token, pending: PendingTier2 | null): boolean {
  return pending != null && pending.requestId === token.requestId
}

/** True iff this request's page is still BOTH the page the gauge is integrating and the page
 *  the active-page record names.
 *
 *  Two sources, because they answer different questions and lag differently. The gauge's
 *  `activePageKey` moves the instant the user leaves a page (the `neutral` hold rewrites it),
 *  while the active-page RECORD is only rewritten once the next page has survived its full
 *  dwell and been judged — several seconds later, if ever. So the record alone still names the
 *  abandoned page right after a leave, and cannot answer "has the user moved on?".
 *
 *  Shared by the pre-gate (before spending a judge call) and the apply guard, deliberately: a
 *  request the pre-gate lets through must be one the apply guard can still use. They drifted
 *  apart once — see the pre-gate's comment in gaugeRuntime.serviceTier2. */
export function tokenPageStillActive(
  token: Tier2Token,
  gaugePageKey: string | null,
  activeRecordPageKey: string | null,
): boolean {
  return gaugePageKey === token.pageKey && activeRecordPageKey === token.pageKey
}

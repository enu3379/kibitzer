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

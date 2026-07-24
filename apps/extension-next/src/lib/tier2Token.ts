// Identity of one Tier-2 request instance, carried end-to-end (enqueue → durable job →
// guarded apply) so an old job can never apply to — or cancel — a newer same-page/reason
// request, or one from a different session.

import type { PendingTier2, Tier2Reason } from "../core/gauge/types.ts"

export interface Tier2Token {
  pageKey: string
  reason: Tier2Reason
  // The EXACT pending slot this request opened. page + reason alone can't tell R1 from a
  // later R2 for the same page.
  requestedAt: number
  // Durable goal epoch — distinguishes sessions even across a clear+redeclare (revision
  // would repeat 0; epoch never does).
  epoch: number
}

/** True iff the live pending slot is still this exact request instance. */
export function tokenMatchesPending(token: Tier2Token, pending: PendingTier2 | null): boolean {
  return (
    pending != null &&
    pending.pageKey === token.pageKey &&
    pending.reason === token.reason &&
    pending.requestedAt === token.requestedAt
  )
}

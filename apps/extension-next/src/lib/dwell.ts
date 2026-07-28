// Durable dwell: a page is judged only after OBSERVE_DWELL_MS of sustained attention. The
// live timer is a setTimeout (fast path), but the pending observation is also checkpointed
// to the SSOT so a service-worker teardown mid-dwell doesn't drop the judgement — the next
// SW wake reconciles it. This module holds the pure decision the timer/reconcile share.

export interface PendingDwell {
  url: string
  title: string
  obsKey: string // pageKey + "\n" + title, the debounce identity
  dueAt: number // epoch ms when the dwell completes and the page should be judged
}

export type DwellAction =
  | { action: "skip" }
  | { action: "rearm"; delayMs: number }
  | { action: "judge"; pending: PendingDwell }

/** Decide what a fired dwell (live timer or wake-time reconcile) should do.
 *  `expectedObsKey` is what the in-memory timer was armed for; pass `null` when reconciling
 *  on wake, to accept whatever is checkpointed. Skip when nothing is pending or it was
 *  superseded by a newer candidate; re-arm when the dwell hasn't fully elapsed yet (e.g. a
 *  reconcile that fires soon after scheduling); otherwise judge. */
export function dwellDecision(
  pending: PendingDwell | null | undefined,
  expectedObsKey: string | null,
  now: number,
): DwellAction {
  if (!pending) return { action: "skip" }
  if (expectedObsKey !== null && pending.obsKey !== expectedObsKey) return { action: "skip" }
  const remaining = pending.dueAt - now
  if (remaining > 0) return { action: "rearm", delayMs: remaining }
  return { action: "judge", pending }
}

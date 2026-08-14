// Durable dwell: a page is judged only after OBSERVE_DWELL_MS of sustained attention. The
// live timer is a setTimeout (fast path), but the pending observation is also checkpointed
// to the SSOT so a service-worker teardown mid-dwell doesn't drop the judgement — the next
// SW wake reconciles it. This module holds the pure decision the timer/reconcile share.

import type { ObservablePageKind } from "./url.ts"

export const PENDING_DWELL_VERSION = 2

export interface DwellCandidate {
  version: typeof PENDING_DWELL_VERSION
  pageKey: string
  title: string
  urlHost: string
  kind: ObservablePageKind
  localPdfPolicyRevision: number | null
  obsKey: string // pageKey + "\n" + title, the debounce identity
}

export interface PendingDwell extends DwellCandidate {
  dueAt: number // epoch ms when the dwell completes and the page should be judged
}

export function isPendingDwell(value: unknown): value is PendingDwell {
  if (!value || typeof value !== "object") return false
  const p = value as Partial<PendingDwell> & { url?: unknown }
  return (
    p.version === PENDING_DWELL_VERSION &&
    p.url === undefined &&
    typeof p.pageKey === "string" &&
    typeof p.title === "string" &&
    typeof p.urlHost === "string" &&
    (p.kind === "web" || p.kind === "local_pdf") &&
    ((p.kind === "web" && p.localPdfPolicyRevision === null) ||
      (p.kind === "local_pdf" &&
        typeof p.localPdfPolicyRevision === "number" &&
        Number.isSafeInteger(p.localPdfPolicyRevision) &&
        p.localPdfPolicyRevision >= 0)) &&
    typeof p.obsKey === "string" &&
    typeof p.dueAt === "number" &&
    Number.isFinite(p.dueAt)
  )
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

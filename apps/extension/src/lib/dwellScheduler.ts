// Durable dwell scheduler (B3). A page is judged only after `dwellMs` of sustained
// attention; the live timer is a setTimeout (fast path) but the pending observation is
// checkpointed to the SSOT so a service-worker teardown mid-dwell doesn't drop it —
// reconcile() resumes it on the next wake. Extracted from background.ts as an injectable
// unit (judge callback + timer) so the teardown / duplicate / stale paths are testable
// against real IndexedDB, mirroring the original extension's PersistentDwellScheduler.

import { kvDelete, kvDeleteIf, kvGet, kvSet } from "./db.ts"
import { dwellDecision, isPendingDwell, type DwellCandidate, type PendingDwell } from "./dwell.ts"

export const PENDING_DWELL_KEY = "pending-dwell"

/** The pageKey portion of an obsKey (`pageKey + "\n" + title`) — the page identity a title
 *  change does not alter. With query-inclusive pageKeys (B4) this correctly separates SPA
 *  content (youtube ?v=A vs ?v=B) while treating same-URL title churn as the same page. */
export interface DwellSchedulerOptions {
  dwellMs: number
  judge: (pending: PendingDwell) => Promise<void>
  // Injectable timer/clock — tests drive fire()/reconcile() directly with no real timers.
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export class DwellScheduler {
  private readonly opts: DwellSchedulerOptions
  private timer: unknown = null
  private judgingObsKey: string | null = null
  private reconciling = false

  constructor(opts: DwellSchedulerOptions) {
    this.opts = opts
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private arm(fn: () => void, ms: number): void {
    const setTimer = this.opts.setTimer ?? ((f, m) => setTimeout(f, m) as unknown)
    this.timer = setTimer(fn, ms)
  }

  private disarm(): void {
    if (this.timer == null) return
    const clearTimer =
      this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    clearTimer(this.timer)
    this.timer = null
  }

  /** Checkpoint a candidate observation and arm the dwell. A candidate on the SAME pageKey
   *  whose dwell is still pending keeps the existing deadline (only title/url refresh), so
   *  same-page title churn (notification counters like "(3) Home") or a storm of duplicate
   *  events can't keep pushing the deadline out and starve the judge. A different pageKey —
   *  including SPA content (youtube ?v=A→?v=B, now distinct under B4) — starts a fresh dwell,
   *  so real content isn't judged under-dwelt. Preserving only a still-FUTURE deadline also
   *  avoids instantly judging a stale past-deadline checkpoint revived after a teardown. */
  async schedule(candidate: DwellCandidate): Promise<void> {
    const rawExisting = await kvGet<unknown>(PENDING_DWELL_KEY)
    const existing = isPendingDwell(rawExisting) ? rawExisting : undefined
    const samePage =
      existing != null &&
      existing.pageKey === candidate.pageKey &&
      existing.kind === candidate.kind &&
      existing.localPdfPolicyRevision === candidate.localPdfPolicyRevision &&
      existing.dueAt > this.now()
    const dueAt = samePage ? existing.dueAt : this.now() + this.opts.dwellMs
    await kvSet(PENDING_DWELL_KEY, { ...candidate, dueAt })
    this.disarm()
    this.arm(() => void this.fire(candidate.obsKey), Math.max(0, dueAt - this.now()))
  }

  /** Cancel any pending dwell (navigated away / went idle / lost focus). */
  async cancel(): Promise<void> {
    this.disarm()
    await kvDelete(PENDING_DWELL_KEY)
  }

  /** Remove one stale invocation without touching a newer policy revision's checkpoint/timer. */
  async cancelCandidate(candidate: DwellCandidate): Promise<void> {
    await kvDeleteIf(PENDING_DWELL_KEY, (value) => {
      if (!isPendingDwell(value)) return false
      return (
        value.obsKey === candidate.obsKey &&
        value.localPdfPolicyRevision === candidate.localPdfPolicyRevision
      )
    })
  }

  /** Fire the checkpointed dwell — from the live timer (`expectedObsKey` set) or a wake-time
   *  reconcile (`null`). Skips a superseded candidate, re-arms if the dwell hasn't elapsed,
   *  else judges. The checkpoint is deleted only AFTER a successful judge, and only if it is
   *  still the record we judged (CAS) — so a slow judge can't clobber a newer dwell, and a
   *  teardown mid-judge leaves the record for reconcile to retry. */
  async fire(expectedObsKey: string | null): Promise<void> {
    const rawPending = await kvGet<unknown>(PENDING_DWELL_KEY)
    if (rawPending !== undefined && !isPendingDwell(rawPending)) {
      // Pre-v2 checkpoints contain a raw URL. Never revive them: delete only if the current
      // value is still malformed, so a concurrent valid schedule cannot be clobbered.
      await kvDeleteIf(PENDING_DWELL_KEY, (value) => !isPendingDwell(value))
      return
    }
    const pending = rawPending as PendingDwell | undefined
    const decision = dwellDecision(pending, expectedObsKey, this.now())
    if (decision.action === "skip") return
    if (decision.action === "rearm") {
      this.disarm()
      const obsKey = pending?.obsKey ?? null
      this.arm(() => void this.fire(obsKey), decision.delayMs)
      return
    }
    const p = decision.pending
    if (this.judgingObsKey === p.obsKey) return // single-flight per candidate
    this.judgingObsKey = p.obsKey
    try {
      await this.opts.judge(p)
      // Delete only after a successful judge, and only if the checkpoint is still the one we
      // judged (CAS) — a mid-judge teardown or a newer dwell both leave it for reconcile.
      await kvDeleteIf(PENDING_DWELL_KEY, (v) => {
        if (!isPendingDwell(v)) return false
        return v.obsKey === p.obsKey && v.dueAt === p.dueAt
      })
    } catch {
      // Judge failed (or the worker was torn down mid-judge): leave the checkpoint so a
      // later reconcile retries it. Never let it escape into the timer/wake caller.
    } finally {
      this.judgingObsKey = null
    }
  }

  /** On service-worker wake, resume a dwell that was in flight when the previous lifetime
   *  ended. Single-flight so a module-load reconcile and an onStartup reconcile can't run
   *  concurrently. */
  async reconcile(): Promise<void> {
    if (this.reconciling) return
    this.reconciling = true
    try {
      await this.fire(null)
    } finally {
      this.reconciling = false
    }
  }
}

// Durable dwell scheduler (B3). A page is judged only after `dwellMs` of sustained
// attention; the live timer is a setTimeout (fast path) but the pending observation is
// checkpointed to the SSOT so a service-worker teardown mid-dwell doesn't drop it —
// reconcile() resumes it on the next wake. Extracted from background.ts as an injectable
// unit (judge callback + timer) so the teardown / duplicate / stale paths are testable
// against real IndexedDB, mirroring the original extension's PersistentDwellScheduler.

import { kvDelete, kvDeleteIf, kvGet, kvSet } from "./db.ts"
import { dwellDecision, type PendingDwell } from "./dwell.ts"

export const PENDING_DWELL_KEY = "pending-dwell"

/** The host+path portion of an obsKey (`pageKey + "\n" + title`) — the page identity that a
 *  title change does not alter. */
function pathOf(obsKey: string): string {
  const nl = obsKey.indexOf("\n")
  return nl === -1 ? obsKey : obsKey.slice(0, nl)
}

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

  /** Checkpoint a candidate observation and arm the dwell. A candidate on the SAME page
   *  (same host+path) as the current checkpoint keeps the existing deadline — only the
   *  title/url are refreshed — so title churn (notification counters like "(3) Home") or a
   *  storm of duplicate events can't keep pushing the deadline out and starve the judge. A
   *  genuinely new page (different path) starts a fresh dwell. */
  async schedule(url: string, title: string, obsKey: string): Promise<void> {
    const existing = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
    const samePage = existing != null && pathOf(existing.obsKey) === pathOf(obsKey)
    const dueAt = samePage ? existing.dueAt : this.now() + this.opts.dwellMs
    await kvSet(PENDING_DWELL_KEY, { url, title, obsKey, dueAt })
    this.disarm()
    this.arm(() => void this.fire(obsKey), Math.max(0, dueAt - this.now()))
  }

  /** Cancel any pending dwell (navigated away / went idle / lost focus). */
  async cancel(): Promise<void> {
    this.disarm()
    await kvDelete(PENDING_DWELL_KEY)
  }

  /** Fire the checkpointed dwell — from the live timer (`expectedObsKey` set) or a wake-time
   *  reconcile (`null`). Skips a superseded candidate, re-arms if the dwell hasn't elapsed,
   *  else judges. The checkpoint is deleted only AFTER a successful judge, and only if it is
   *  still the record we judged (CAS) — so a slow judge can't clobber a newer dwell, and a
   *  teardown mid-judge leaves the record for reconcile to retry. */
  async fire(expectedObsKey: string | null): Promise<void> {
    const pending = await kvGet<PendingDwell>(PENDING_DWELL_KEY)
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
        const d = v as PendingDwell
        return d?.obsKey === p.obsKey && d?.dueAt === p.dueAt
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

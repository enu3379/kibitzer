// Integration test for the durable dwell scheduler (B3), against real IndexedDB
// (fake-indexeddb). Mirrors the original extension's persistentDwell tests: restart
// restore, stale cancel, retry after a mid-judge teardown, duplicate single-flight, and the
// CAS delete that must not clobber a newer dwell. Timers are stubbed out so fire()/
// reconcile() are driven directly.

import "fake-indexeddb/auto"
import assert from "node:assert/strict"
import test from "node:test"

import { DwellScheduler, PENDING_DWELL_KEY } from "./dwellScheduler.ts"
import { kvGet } from "./db.ts"

const noTimer = { setTimer: () => 0, clearTimer: () => {} }

function makeClock(start: number) {
  return { t: start, now() { return this.t } }
}

async function checkpoint(): Promise<{ obsKey: string; dueAt: number } | undefined> {
  return kvGet(PENDING_DWELL_KEY)
}

test("resumes a dwell scheduled by a torn-down worker (restart restore)", async () => {
  const clock = makeClock(1000)
  const judged: string[] = []
  const judge = async (p: { obsKey: string }) => void judged.push(p.obsKey)

  // Worker 1 schedules, then is torn down (its in-memory timer is gone).
  const w1 = new DwellScheduler({ dwellMs: 5000, judge, now: () => clock.t, ...noTimer })
  await w1.schedule("https://a/x", "X", "a/x\nX")
  assert.equal((await checkpoint())?.dueAt, 6000)

  // Worker 2 wakes before the dwell elapsed → re-arm, no judge yet.
  clock.t = 3000
  const w2 = new DwellScheduler({ dwellMs: 5000, judge, now: () => clock.t, ...noTimer })
  await w2.reconcile()
  assert.deepEqual(judged, [])
  assert.ok(await checkpoint(), "checkpoint still pending")

  // Worker 2 wakes again after it elapsed → judge once, checkpoint cleared.
  clock.t = 6000
  await w2.reconcile()
  assert.deepEqual(judged, ["a/x\nX"])
  assert.equal(await checkpoint(), undefined)
})

test("a superseding candidate cancels the stale dwell", async () => {
  const clock = makeClock(1000)
  const judged: string[] = []
  const s = new DwellScheduler({
    dwellMs: 5000,
    judge: async (p) => void judged.push(p.obsKey),
    now: () => clock.t,
    ...noTimer,
  })
  await s.schedule("https://a/x", "X", "a/x\nX")
  await s.schedule("https://b/y", "Y", "b/y\nY") // overwrites the checkpoint

  clock.t = 7000
  await s.fire("a/x\nX") // the old timer fires with the stale obsKey → skip
  assert.deepEqual(judged, [], "stale candidate not judged")
  assert.equal((await checkpoint())?.obsKey, "b/y\nY", "the new candidate is intact")
})

test("cancel() drops the pending dwell (idle / focus-loss)", async () => {
  const clock = makeClock(1000)
  let judged = 0
  const s = new DwellScheduler({ dwellMs: 5000, judge: async () => void (judged += 1), now: () => clock.t, ...noTimer })
  await s.schedule("https://a/x", "X", "a/x\nX")
  await s.cancel()
  clock.t = 9000
  await s.reconcile()
  assert.equal(judged, 0)
  assert.equal(await checkpoint(), undefined)
})

test("a mid-judge teardown leaves the checkpoint; a later reconcile retries it", async () => {
  const clock = makeClock(1000)
  let attempts = 0
  const judge = async () => {
    attempts += 1
    if (attempts === 1) throw new Error("worker torn down mid-judge")
  }
  const s = new DwellScheduler({ dwellMs: 5000, judge, now: () => clock.t, ...noTimer })
  await s.schedule("https://a/x", "X", "a/x\nX")

  clock.t = 6000
  await s.reconcile() // judge throws → checkpoint survives
  assert.equal(attempts, 1)
  assert.ok(await checkpoint(), "kept for retry after the failed judge")

  await s.reconcile() // retry succeeds → cleared
  assert.equal(attempts, 2)
  assert.equal(await checkpoint(), undefined)
})

test("duplicate concurrent fires run the judge once (single-flight)", async () => {
  const clock = makeClock(6000)
  let running = 0
  let maxConcurrent = 0
  let calls = 0
  const judge = async () => {
    calls += 1
    running += 1
    maxConcurrent = Math.max(maxConcurrent, running)
    await Promise.resolve() // yield so a second fire could interleave
    running -= 1
  }
  const s = new DwellScheduler({ dwellMs: 5000, judge, now: () => clock.t, ...noTimer })
  // Schedule at t=6000 with a 0 dwell-equivalent by advancing past dueAt.
  await s.schedule("https://a/x", "X", "a/x\nX")
  clock.t = 12000
  await Promise.all([s.fire("a/x\nX"), s.fire("a/x\nX")])
  assert.equal(calls, 1, "judged exactly once")
  assert.equal(maxConcurrent, 1)
  assert.equal(await checkpoint(), undefined)
})

test("CAS delete never clobbers a newer dwell scheduled during a slow judge", async () => {
  const clock = makeClock(6000)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const inJudge = new Promise<void>((r) => (entered = r))
  const s = new DwellScheduler({
    dwellMs: 5000,
    judge: async () => {
      entered() // judge A has begun (past its checkpoint read)
      await gate // …and hangs until we schedule B
    },
    now: () => clock.t,
    ...noTimer,
  })
  await s.schedule("https://a/x", "X", "a/x\nX")
  clock.t = 12000
  const judging = s.fire("a/x\nX") // begins judging A, awaiting the gate
  await inJudge
  await s.schedule("https://b/y", "Y", "b/y\nY") // a new dwell lands mid-judge
  release()
  await judging
  assert.equal((await checkpoint())?.obsKey, "b/y\nY", "A's completion must not delete B")
})

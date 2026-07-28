import assert from "node:assert/strict"
import test from "node:test"

import {
  emptyVisits,
  MAX_OPEN_MS,
  reduceVisits,
  VISIT_CAP,
  type SessionVisits,
  type VisitAction,
} from "./visits.ts"

const EPOCH = 7

function run(actions: VisitAction[], start: SessionVisits | null = null, epoch = EPOCH): SessionVisits {
  return actions.reduce((v: SessionVisits | null, a) => reduceVisits(v, a, epoch), start)!
}

const judged = (pageKey: string, ts: number, verdict: "OK" | "DRIFT" = "OK"): VisitAction => ({
  type: "judged",
  pageKey,
  title: `Title ${pageKey}`,
  host: `${pageKey}.test`,
  verdict,
  ts,
})

test("judged opens an interval and creates the entry at 0ms", () => {
  const v = run([judged("a", 1000)])
  assert.equal(v.entries.a.ms, 0)
  assert.equal(v.entries.a.verdict, "OK")
  assert.deepEqual(v.open, { pageKey: "a", since: 1000 })
})

test("judged while not present records the entry/verdict but opens no interval", () => {
  const v = run([{ type: "judged", pageKey: "a", title: "T", host: "a.test", verdict: "OK", present: false, ts: 1000 }])
  assert.equal(v.entries.a.ms, 0, "entry recorded")
  assert.equal(v.entries.a.verdict, "OK")
  assert.equal(v.open, null, "no interval opened while the user is away")
})

test("a late verdict while away does not accrue bogus dwell before the next close", () => {
  const v = run([
    { type: "judged", pageKey: "a", title: "T", host: "a.test", verdict: "DRIFT", present: false, ts: 1000 },
    { type: "inactive", ts: 91_000 }, // 90s later, still nothing open → no time credited
  ])
  assert.equal(v.entries.a.ms, 0)
  assert.equal(v.open, null)
})

test("inactive closes and credits the elapsed time", () => {
  const v = run([judged("a", 1000), { type: "inactive", ts: 31_000 }])
  assert.equal(v.entries.a.ms, 30_000)
  assert.equal(v.open, null)
})

test("observe of an unjudged page closes the previous interval without opening one", () => {
  const v = run([judged("a", 0), { type: "observe", pageKey: "b", ts: 10_000 }])
  assert.equal(v.entries.a.ms, 10_000)
  assert.equal(v.open, null)
  assert.equal(v.entries.b, undefined)
})

test("observe of the already-open page is a no-op (SPA title churn)", () => {
  const before = run([judged("a", 0)])
  const after = reduceVisits(before, { type: "observe", pageKey: "a", ts: 4_000 }, EPOCH)
  assert.deepEqual(after, before)
})

test("presence-resume reopens a judged page via observe", () => {
  const v = run([
    judged("a", 0),
    { type: "inactive", ts: 10_000 }, // user left
    { type: "observe", pageKey: "a", ts: 60_000 }, // back on the same page
    { type: "inactive", ts: 70_000 },
  ])
  assert.equal(v.entries.a.ms, 20_000) // 10s before + 10s after; the away gap not counted
})

test("heartbeat checkpoints in steps without losing continuity", () => {
  const v = run([
    judged("a", 0),
    { type: "heartbeat", ts: 60_000 },
    { type: "heartbeat", ts: 120_000 },
    { type: "inactive", ts: 150_000 },
  ])
  assert.equal(v.entries.a.ms, 150_000)
})

test("an over-long open interval is clamped to MAX_OPEN_MS (teardown/sleep gap)", () => {
  const v = run([judged("a", 0), { type: "inactive", ts: 10 * 60_000 }])
  assert.equal(v.entries.a.ms, MAX_OPEN_MS)
})

test("A→B→A revisits accumulate onto one entry", () => {
  const v = run([
    judged("a", 0),
    judged("b", 20_000),
    judged("a", 50_000), // re-judge on return
    { type: "inactive", ts: 60_000 },
  ])
  assert.equal(v.entries.a.ms, 30_000) // 20s + 10s
  assert.equal(v.entries.b.ms, 30_000)
  assert.equal(Object.keys(v.entries).length, 2)
})

test("a re-judge flips the verdict (Tier-1 rescue path), latest wins", () => {
  const v = run([judged("a", 0, "DRIFT"), judged("a", 10_000, "OK")])
  assert.equal(v.entries.a.verdict, "OK")
  assert.equal(v.entries.a.ms, 10_000)
})

test("verdict action (related feedback) flips an existing entry and creates a missing one", () => {
  const flip = run([
    judged("a", 0, "DRIFT"),
    { type: "verdict", pageKey: "a", title: "Title a", host: "a.test", verdict: "OK", ts: 5_000 },
  ])
  assert.equal(flip.entries.a.verdict, "OK")
  const create = run([
    { type: "verdict", pageKey: "z", title: "Z", host: "z.test", verdict: "OK", ts: 0 },
  ])
  assert.equal(create.entries.z.ms, 0)
  assert.deepEqual(create.open, { pageKey: "z", since: 0 })
})

test("an epoch mismatch resets the tracker", () => {
  const old = run([judged("a", 0)], null, EPOCH)
  const next = reduceVisits(old, judged("b", 1_000), EPOCH + 1)
  assert.equal(next.epoch, EPOCH + 1)
  assert.equal(next.entries.a, undefined)
  assert.ok(next.entries.b)
})

test("eviction over the cap folds counts into the aggregates, keeping totals exact", () => {
  let v: SessionVisits | null = null
  for (let i = 0; i <= VISIT_CAP; i += 1) {
    // Every page gets 1s of dwell before the next judgement closes it.
    v = reduceVisits(v, judged(`p${i}`, i * 1_000, i % 2 === 0 ? "OK" : "DRIFT"), EPOCH)
  }
  v = reduceVisits(v, { type: "inactive", ts: (VISIT_CAP + 1) * 1_000 }, EPOCH)
  assert.equal(Object.keys(v!.entries).length, VISIT_CAP)
  assert.equal(v!.evicted.pages, 1)
  const totalPages = Object.keys(v!.entries).length + v!.evicted.pages
  assert.equal(totalPages, VISIT_CAP + 1)
  const totalMs =
    Object.values(v!.entries).reduce((s, e) => s + e.ms, 0) + v!.evicted.ms
  assert.equal(totalMs, (VISIT_CAP + 1) * 1_000)
})

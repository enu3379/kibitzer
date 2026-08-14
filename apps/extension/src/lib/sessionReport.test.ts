import assert from "node:assert/strict"
import test from "node:test"

import type { KibitzerEvent } from "./events.ts"
import { computeReport, resampleSeries, SCURVE_POINTS } from "./sessionReport.ts"
import { emptyVisits, type SessionVisits } from "./visits.ts"

const MIN = 60_000
const GOAL = { startedAt: 0, availableMinutes: 60, epoch: 1 }
const NOW = 87 * MIN

function visits(): SessionVisits {
  const v = emptyVisits(1)
  v.entries = {
    velog: { pageKey: "velog", title: "어텐션 리뷰", host: "velog.io", verdict: "OK", ms: 21 * MIN, lastSeen: 0 },
    arxiv: { pageKey: "arxiv", title: "arxiv paper", host: "arxiv.org", verdict: "OK", ms: 18 * MIN, lastSeen: 0 },
    insta: { pageKey: "insta", title: "insta", host: "instagram.com", verdict: "DRIFT", ms: 8 * MIN, lastSeen: 0 },
  }
  return v
}

const ev = (ts: number, type: string, data: Record<string, unknown>): KibitzerEvent => ({ ts, type, data })

function events(): KibitzerEvent[] {
  return [
    ev(0, "observe", { host: "arxiv.org", verdict: "OK" }),
    ev(10 * MIN, "tick", { s: 80 }),
    ev(18 * MIN, "observe", { host: "instagram.com", verdict: "DRIFT" }), // first drift
    ev(20 * MIN, "observe", { host: "arxiv.org", verdict: "OK" }), // returned (episode 2min)
    ev(30 * MIN, "tick", { s: 31 }), // lowest
    ev(40 * MIN, "observe", { host: "instagram.com", verdict: "DRIFT" }),
    ev(42 * MIN, "observe", { host: "velog.io", verdict: "OK" }),
    ev(50 * MIN, "presence", { present: false }),
    ev(55 * MIN, "presence", { present: true }), // away 5min
  ]
}

test("computeReport joins tracker time with the event sequence", () => {
  const r = computeReport(visits(), events(), { count: 3, acted: 2 }, GOAL, NOW)

  // sequence-derived (present-gated: the 5min away window is excluded from durations)
  assert.equal(r.driftVisits, 2)
  assert.equal(r.timeToFirstDriftMs, 18 * MIN)
  assert.equal(r.avgDriftEpisodeMs, 2 * MIN) // (2 + 2) / 2
  assert.equal(r.longestDriftMs, 2 * MIN)
  assert.equal(r.longestFocusMs, 40 * MIN) // final OK run 42→87min minus the 5min away
  assert.equal(r.ending, "OK")
  assert.equal(r.driftClock, "early")
  assert.equal(r.secondHalfTrend, "up")

  // presence / gauge / nag
  assert.equal(r.awayCount, 1)
  assert.equal(r.awayMs, 5 * MIN)
  assert.equal(r.lowestS, 31)
  assert.deepEqual({ c: r.nagCount, a: r.nagActed }, { c: 3, a: 2 })

  // tracker-derived
  assert.equal(r.distinctHosts, 3)
  assert.equal(r.goalMinutes, 60)
  assert.equal(r.activeMinutes, 47) // Σ tracker dwell (21+18+8), NOT the 87min wall-clock
  assert.equal(r.mvp?.title, "어텐션 리뷰") // longest OK page (21min)
  assert.equal(r.villain?.label, "📷 인스타그램") // most drift time
  assert.equal(r.villain?.ms, 8 * MIN)
  assert.deepEqual(r.siteBars.map((h) => h.host), ["velog.io", "arxiv.org", "instagram.com"])

  // top drift host leaderboard (by visits)
  assert.equal(r.topDriftHosts[0].label, "📷 인스타그램")
  assert.equal(r.topDriftHosts[0].visits, 2)

  // immersion S-curve resampled from the two tick events
  assert.equal(r.sCurve.length, SCURVE_POINTS)
  assert.equal(r.sCurve[0], 80) // first tick
  assert.equal(r.sCurve[r.sCurve.length - 1], 31) // last tick
})

test("resampleSeries stretches/compresses to a fixed length by linear interpolation", () => {
  assert.deepEqual(resampleSeries([], 3), [])
  assert.deepEqual(resampleSeries([42], 3), [42, 42, 42]) // constant fill
  assert.deepEqual(resampleSeries([0, 100], 3), [0, 50, 100]) // midpoint interpolated
  assert.deepEqual(resampleSeries([0, 50, 100, 50], 4), [0, 50, 100, 50]) // identity length
})

test("a long idle gap (goal left open overnight) does not inflate durations", () => {
  const v = emptyVisits(1)
  v.entries = { a: { pageKey: "a", title: "T", host: "arxiv.org", verdict: "OK", ms: 3 * MIN, lastSeen: 0 } }
  const evs = [
    ev(0, "observe", { host: "arxiv.org", verdict: "OK" }),
    ev(2 * MIN, "presence", { present: false }), // stepped away
    ev(600 * MIN, "presence", { present: true }), // back 10 hours later
    ev(601 * MIN, "observe", { host: "instagram.com", verdict: "DRIFT" }),
  ]
  const r = computeReport(v, evs, { count: 0, acted: 0 }, { startedAt: 0, availableMinutes: 60, epoch: 1 }, 602 * MIN)
  assert.equal(r.timeToFirstDriftMs, 3 * MIN) // 2min + 1min present; the 10h away is excluded
  assert.ok(r.longestFocusMs <= 3 * MIN, "focus streak must not span the idle gap")
  assert.equal(r.activeMinutes, 3) // tracker time, not the ~10h wall-clock
  assert.equal(r.awayCount, 1)
})

test("a clean session reports no drift and no villain", () => {
  const v = emptyVisits(1)
  v.entries = { a: { pageKey: "a", title: "T", host: "arxiv.org", verdict: "OK", ms: 30 * MIN, lastSeen: 0 } }
  const r = computeReport(v, [ev(0, "observe", { host: "arxiv.org", verdict: "OK" })], { count: 0, acted: 0 }, GOAL, 30 * MIN)
  assert.equal(r.driftVisits, 0)
  assert.equal(r.driftMs, 0)
  assert.deepEqual(r.topDriftHosts, [])
  assert.equal(r.villain, null)
  assert.equal(r.timeToFirstDriftMs, null)
  assert.equal(r.mvp?.host, "arxiv.org")
})

test("visits from another epoch are ignored (host aggregation empty)", () => {
  const r = computeReport(visits(), events(), { count: 0, acted: 0 }, { ...GOAL, epoch: 2 }, NOW)
  assert.equal(r.distinctHosts, 0)
  assert.equal(r.mvp, null)
  assert.equal(r.siteBars.length, 0)
  // sequence stats still come from events (not epoch-scoped by the tracker)
  assert.equal(r.driftVisits, 2)
})

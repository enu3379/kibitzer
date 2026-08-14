import assert from "node:assert/strict"
import test from "node:test"

import { computeComparison, type SessionHistoryEntry } from "./sessionHistory.ts"

const entry = (over: Partial<SessionHistoryEntry>): SessionHistoryEntry => ({
  epoch: 1,
  endedAt: 0,
  okRatio: 0.5,
  validMs: 30 * 60_000,
  driftVisits: 4,
  activeMs: 60 * 60_000,
  pagesTotal: 10,
  nagCount: 2,
  sCurve: [],
  ...over,
})

test("no prior sessions → empty comparison", () => {
  const c = computeComparison(entry({ epoch: 3 }), [])
  assert.deepEqual(c, { sessions: 0, vsLast: null, vsAvg: null, lastSCurve: null, avgSCurve: null })
})

test("S-curves overlay: last is the previous session, avg is the pointwise mean", () => {
  const current = entry({ epoch: 3, sCurve: [100, 50, 0] })
  const c = computeComparison(current, [
    entry({ epoch: 1, sCurve: [80, 40, 20] }),
    entry({ epoch: 2, sCurve: [60, 60, 60] }),
  ])
  assert.deepEqual(c.lastSCurve, [60, 60, 60]) // most recent prior
  assert.deepEqual(c.avgSCurve, [70, 50, 40]) // mean of the two priors
})

test("vsLast compares to the most recent prior session", () => {
  const current = entry({ epoch: 3, okRatio: 0.7, validMs: 40 * 60_000, driftVisits: 2 })
  const history = [
    entry({ epoch: 1, okRatio: 0.4, validMs: 20 * 60_000, driftVisits: 6 }),
    entry({ epoch: 2, okRatio: 0.5, validMs: 30 * 60_000, driftVisits: 4 }), // last
  ]
  const c = computeComparison(current, history)
  assert.equal(c.sessions, 2)
  assert.ok(Math.abs((c.vsLast!.okRatioDelta ?? 0) - 0.2) < 1e-9) // 0.7 − 0.5
  assert.equal(c.vsLast!.validMsDelta, 10 * 60_000)
  assert.equal(c.vsLast!.driftVisitsDelta, -2) // improved: fewer drifts
})

test("vsAvg compares to the mean of prior sessions", () => {
  const current = entry({ epoch: 3, okRatio: 0.6, driftVisits: 3 })
  const history = [
    entry({ epoch: 1, okRatio: 0.4, driftVisits: 6 }),
    entry({ epoch: 2, okRatio: 0.6, driftVisits: 2 }),
  ]
  const c = computeComparison(current, history)
  assert.ok(Math.abs((c.vsAvg!.okRatioDelta ?? 0) - 0.1) < 1e-9) // 0.6 − mean(0.4,0.6)=0.5
  assert.equal(c.vsAvg!.driftVisitsDelta, 3 - 4) // 3 − mean(6,2)=4
})

test("the current session is never compared against itself; empty sessions are excluded", () => {
  const current = entry({ epoch: 3, okRatio: 0.7 })
  const history = [
    entry({ epoch: 3, okRatio: 0.1 }), // same epoch (a re-finalize) — must be ignored
    entry({ epoch: 2, okRatio: 0.5, pagesTotal: 0 }), // empty session — must be ignored
  ]
  assert.deepEqual(computeComparison(current, history), {
    sessions: 0,
    vsLast: null,
    vsAvg: null,
    lastSCurve: null,
    avgSCurve: null,
  })
})

test("okRatioDelta is null when either side had no judged pages", () => {
  const current = entry({ epoch: 3, okRatio: null })
  const c = computeComparison(current, [entry({ epoch: 1, okRatio: 0.5 })])
  assert.equal(c.vsLast!.okRatioDelta, null)
  assert.equal(c.vsLast!.driftVisitsDelta, 0)
})

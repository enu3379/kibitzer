import assert from "node:assert/strict"
import test from "node:test"

import {
  admissionEligible,
  BETA,
  DERIVED_TAU,
  l2normalize,
  meanVector,
  scoreParts,
} from "./relevance.ts"

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

test("scoreParts falls back to the goal cosine with no refs", () => {
  const parts = scoreParts([1, 0], [1, 0], { exemplars: [], anchor: null, derived: [] })
  assert.ok(close(parts.score, 1))
  assert.ok(close(parts.exemplarScore, 1))
  assert.equal(parts.anchorScore, 0)
})

test("an exemplar closer than the goal wins the max", () => {
  const parts = scoreParts([0, 1], [1, 0], { exemplars: [[0, 1]], anchor: null, derived: [] })
  assert.ok(close(parts.exemplarScore, 1)) // max(goal·page=0, exemplar·page=1)
  assert.ok(close(parts.score, 1))
})

test("anchor contributes beta * cosine", () => {
  const parts = scoreParts([0, 1], [1, 0], { exemplars: [], anchor: [0, 1], derived: [] })
  assert.ok(close(parts.anchorScore, BETA))
  assert.ok(close(parts.score, BETA)) // exemplar(goal)=0 < 0.85
})

test("derived contributes only at/above derived_tau", () => {
  // page nearly orthogonal to the derived phrase → below tau → no contribution
  const below = scoreParts([0.99, Math.sqrt(1 - 0.99 * 0.99)], [1, 0], {
    exemplars: [],
    anchor: null,
    derived: [[0, 1]],
  })
  assert.ok(below.derivedScore < DERIVED_TAU)
  assert.ok(close(below.score, below.exemplarScore)) // derived dropped
  const above = scoreParts([0, 1], [1, 0], { exemplars: [], anchor: null, derived: [[0, 1]] })
  assert.ok(close(above.derivedScore, 1))
  assert.ok(close(above.score, 1))
})

test("meanVector averages then re-normalizes to a unit vector", () => {
  const m = meanVector([[1, 0], [0, 1]]) as number[]
  assert.ok(close(m[0], Math.SQRT1_2) && close(m[1], Math.SQRT1_2))
  assert.equal(meanVector([]), null)
  const n = l2normalize([3, 4])
  assert.ok(close(n[0], 0.6) && close(n[1], 0.8))
})

test("anchor admission blocks anchor-only OKs but allows exemplar/tier1 OKs", () => {
  const anchorOnly = { score: 0.7, exemplarScore: 0.01, anchorScore: 0.7, derivedScore: 0 }
  assert.equal(admissionEligible(anchorOnly, false, "OK", 0), false)
  const byExemplar = { score: 0.7, exemplarScore: 0.6, anchorScore: 0, derivedScore: 0 }
  assert.equal(admissionEligible(byExemplar, false, "OK", 0), true)
  assert.equal(admissionEligible(anchorOnly, false, "OK", 1), true) // Tier-1-confirmed OK
})

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

test("anchor contributes beta * cosine when the tiebreak floor is off", () => {
  const parts = scoreParts([0, 1], [1, 0], { exemplars: [], anchor: [0, 1], derived: [] }, 0)
  assert.ok(close(parts.anchorScore, BETA))
  assert.ok(close(parts.score, BETA)) // exemplar(goal)=0 < 0.85 — legacy solo-anchor OK
})

// --- anchor tiebreak floor (pollution-loop fix, old server PR #118) ---------------

const exemplarAt = (c: number): number[] => [c, Math.sqrt(1 - c * c)]

test("anchor cannot solo-OK a page below the affinity floor", () => {
  // polluted anchor perfectly aligned with the page, goal affinity only 0.2
  const parts = scoreParts([1, 0], [0, 1], { exemplars: [exemplarAt(0.2)], anchor: [1, 0], derived: [] }, 0.3)
  assert.ok(close(parts.anchorScore, BETA)) // raw diagnostic preserved
  assert.ok(close(parts.score, 0.2)) // anchor excluded from the verdict score
})

test("anchor lifts a page at/above the affinity floor", () => {
  const parts = scoreParts([1, 0], [0, 1], { exemplars: [exemplarAt(0.35)], anchor: [1, 0], derived: [] }, 0.3)
  assert.ok(close(parts.score, BETA))
})

test("derived affinity also unlocks the anchor", () => {
  const parts = scoreParts([1, 0], [0, 1], { exemplars: [], anchor: [1, 0], derived: [exemplarAt(0.4)] }, 0.3)
  assert.ok(close(parts.score, BETA))
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

test("anchor admission blocks anchor-only OKs but allows exemplar OKs", () => {
  const anchorOnly = { score: 0.7, exemplarScore: 0.01, anchorScore: 0.7, derivedScore: 0 }
  assert.equal(admissionEligible(anchorOnly, false, "OK", 0), false)
  const byExemplar = { score: 0.7, exemplarScore: 0.6, anchorScore: 0, derivedScore: 0 }
  assert.equal(admissionEligible(byExemplar, false, "OK", 0), true)
})

test("a Tier-1 OK needs goal affinity to join the anchor", () => {
  const lowAffinity = { score: 0, exemplarScore: 0.02, anchorScore: 0.9, derivedScore: 0 }
  assert.equal(admissionEligible(lowAffinity, false, "OK", 1, 0), true) // legacy unconditional bypass
  assert.equal(admissionEligible(lowAffinity, false, "OK", 1, 0.3), false) // lone Tier-1 OK can't seed the anchor
})

test("the Tier-1 floor is not voided by the epsilon branch", () => {
  // Affinity above epsilon (0.05) but below the Tier-1 floor (0.30) — the exact
  // profile of the webtoon-binge seed. The epsilon branch must not admit what the
  // Tier-1 gate rejects.
  const bingeSeed = { score: 0, exemplarScore: 0.235, anchorScore: 0.7, derivedScore: 0 }
  assert.equal(admissionEligible(bingeSeed, false, "OK", 1, 0.3), false) // Tier-1 OK: floor applies despite epsilon
  assert.equal(admissionEligible(bingeSeed, false, "OK", 0, 0.3), true) // Tier-0 OK: epsilon branch unchanged
})

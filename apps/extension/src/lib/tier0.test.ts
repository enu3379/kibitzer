import assert from "node:assert/strict"
import test from "node:test"

import { cosine, verdictFor, TAU_OK } from "./tier0.ts"

test("cosine is the dot product of equal-length vectors", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosine([0.6, 0.8], [0.6, 0.8]) - 1) < 1e-12)
})

test("cosine rejects mismatched dimensions", () => {
  assert.throws(() => cosine([1, 2], [1, 2, 3]), /dimensions differ/)
})

test("verdictFor thresholds at tauOk (default 0.59, O4-recalibrated)", () => {
  assert.equal(TAU_OK, 0.59)
  assert.equal(verdictFor(0.59), "OK")
  assert.equal(verdictFor(0.5899999), "DRIFT")
  assert.equal(verdictFor(0.9), "OK")
  assert.equal(verdictFor(0.7, 0.8), "DRIFT")
})

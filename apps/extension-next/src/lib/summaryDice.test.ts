import assert from "node:assert/strict"
import test from "node:test"

import {
  BONUS_CHANCE,
  rollSummaryDice,
  SUMMARY_CLOSINGS,
  SUMMARY_FOCI,
} from "./summaryDice.ts"

/** rand() stub returning a fixed sequence (repeating the last value). */
function seq(...values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

test("rand 0 picks the first options and rolls the bonus", () => {
  assert.deepEqual(rollSummaryDice(seq(0)), {
    focus: SUMMARY_FOCI[0],
    closing: SUMMARY_CLOSINGS[0],
    bonus: true, // 0 < BONUS_CHANCE
  })
})

test("rand ~1 picks the last options and no bonus", () => {
  assert.deepEqual(rollSummaryDice(seq(0.999)), {
    focus: SUMMARY_FOCI[SUMMARY_FOCI.length - 1],
    closing: SUMMARY_CLOSINGS[SUMMARY_CLOSINGS.length - 1],
    bonus: false,
  })
})

test("rand exactly 1 stays in range (index clamp)", () => {
  const dice = rollSummaryDice(seq(1))
  assert.ok((SUMMARY_FOCI as readonly string[]).includes(dice.focus))
  assert.ok((SUMMARY_CLOSINGS as readonly string[]).includes(dice.closing))
})

test("every focus and closing is reachable; bonus threshold is exact", () => {
  for (let i = 0; i < SUMMARY_FOCI.length; i += 1) {
    const r = (i + 0.5) / SUMMARY_FOCI.length
    assert.equal(rollSummaryDice(seq(r, 0.5, 0.5)).focus, SUMMARY_FOCI[i])
  }
  for (let i = 0; i < SUMMARY_CLOSINGS.length; i += 1) {
    const r = (i + 0.5) / SUMMARY_CLOSINGS.length
    assert.equal(rollSummaryDice(seq(0, r, 0.5)).closing, SUMMARY_CLOSINGS[i])
  }
  assert.equal(rollSummaryDice(seq(0, 0, BONUS_CHANCE)).bonus, false) // strict <
  assert.equal(rollSummaryDice(seq(0, 0, BONUS_CHANCE - 1e-9)).bonus, true)
})

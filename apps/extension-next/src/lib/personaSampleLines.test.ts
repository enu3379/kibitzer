import assert from "node:assert/strict"
import test from "node:test"

import { PERSONA_ORDER } from "./personas.data.ts"
import { PERSONA_SAMPLE_LINES, sampleLinesFor } from "./personaSampleLines.ts"

test("every persona in PERSONA_ORDER has both preview lines", () => {
  for (const key of PERSONA_ORDER) {
    const lines = sampleLinesFor(key)
    assert.ok(lines, `missing sample lines for persona "${key}"`)
    assert.ok(lines.hover.length > 0, `empty hover line for "${key}"`)
    assert.ok(lines.picked.length > 0, `empty picked line for "${key}"`)
  }
})

test("no orphaned sample lines for personas that no longer exist", () => {
  for (const key of Object.keys(PERSONA_SAMPLE_LINES)) {
    assert.ok(PERSONA_ORDER.includes(key), `sample lines for unknown persona "${key}"`)
  }
})

test("hover and picked differ so selecting a persona visibly changes the strip", () => {
  for (const key of PERSONA_ORDER) {
    const lines = sampleLinesFor(key)
    assert.ok(lines)
    assert.notEqual(lines.hover, lines.picked, `hover and picked are identical for "${key}"`)
  }
})

test("lines stay inside the quote strip's two-line budget", () => {
  // The strip is ~490px wide at 13px; past ~46 characters Korean copy wraps to a third line
  // and the fixed-height strip starts clipping.
  const MAX = 46
  for (const key of PERSONA_ORDER) {
    const lines = sampleLinesFor(key)
    assert.ok(lines)
    assert.ok(lines.hover.length <= MAX, `hover too long for "${key}": ${lines.hover.length}`)
    assert.ok(lines.picked.length <= MAX, `picked too long for "${key}": ${lines.picked.length}`)
  }
})

test("preview lines carry no unresolved template placeholders", () => {
  // These are literal strings by design — a stray {goal} would render raw in the picker.
  for (const key of PERSONA_ORDER) {
    const lines = sampleLinesFor(key)
    assert.ok(lines)
    assert.doesNotMatch(lines.hover, /\{\w+\}/, `unfilled placeholder in hover for "${key}"`)
    assert.doesNotMatch(lines.picked, /\{\w+\}/, `unfilled placeholder in picked for "${key}"`)
  }
})

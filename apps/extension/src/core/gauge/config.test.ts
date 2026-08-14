import assert from "node:assert/strict"
import test from "node:test"

import { defaultGaugeConfig, tBudgetSeconds } from "./config.ts"

test("tBudgetSeconds falls back for non-positive / non-finite input (no NaN)", () => {
  const fallback = tBudgetSeconds(null)
  assert.equal(tBudgetSeconds(-5), fallback, "negative → fallback")
  assert.equal(tBudgetSeconds(0), fallback, "zero → fallback")
  assert.equal(tBudgetSeconds(Number.NaN), fallback, "NaN → fallback")
  assert.ok(Number.isFinite(tBudgetSeconds(-5)))
})

test("defaultGaugeConfig produces finite drain/recover rates for a negative budget", () => {
  const cfg = defaultGaugeConfig(-5)
  assert.ok(Number.isFinite(cfg.rDrain), `rDrain=${cfg.rDrain}`)
  assert.ok(Number.isFinite(cfg.rRecover), `rRecover=${cfg.rRecover}`)
})

import assert from "node:assert/strict"
import test from "node:test"

import { normalizeSettings } from "../src/lib/api.ts"

test("normalizes an empty settings response to extension defaults", () => {
  assert.deepEqual(normalizeSettings({}), {
    persona: "dry_kibitzer",
    voice_enabled: false,
    relevance: { tau_ok: 0.15 },
    controller: {
      type: "streak",
      k: 3,
      alignment_alpha: 0.85,
      theta_low: 0.15,
      theta_high: 0.3,
    },
    cooldown: { enabled: false, seconds: 0 },
    dwell: { observation_seconds: 5, tier2_seconds: 10 },
    quiet_hours: { enabled: false, start: "09:00", end: "18:00" },
  })
})

test("clamps copied server bounds and preserves strict theta ordering", () => {
  const normalized = normalizeSettings({
    relevance: { tau_ok: 2 },
    controller: {
      type: "alignment",
      k: 100,
      alignment_alpha: -1,
      theta_low: 1,
      theta_high: 0,
    },
    cooldown: { enabled: true, seconds: 100_000 },
    dwell: { observation_seconds: 0, tier2_seconds: 999 },
  })

  assert.deepEqual(normalized.relevance, { tau_ok: 1 })
  assert.deepEqual(normalized.controller, {
    type: "alignment",
    k: 20,
    alignment_alpha: 0,
    theta_low: 0.99,
    theta_high: 1,
  })
  assert.deepEqual(normalized.cooldown, { enabled: true, seconds: 86_400 })
  assert.deepEqual(normalized.dwell, { observation_seconds: 1, tier2_seconds: 300 })
  assert.ok(normalized.controller.theta_low < normalized.controller.theta_high)
})

test("keeps the legacy window alias at the compatibility boundary", () => {
  const normalized = normalizeSettings({
    persona: "quiet_coach",
    voice_enabled: true,
    controller: {
      type: "window",
      k: 4,
      alignment_alpha: 0.5,
      theta_low: 0.7,
      theta_high: 0.2,
    },
    quiet_hours: { enabled: true, start: "22:00", end: "07:00" },
  })

  assert.equal(normalized.controller.type, "alignment")
  assert.equal(normalized.controller.theta_low, 0.7)
  assert.equal(normalized.controller.theta_high, 0.71)
  assert.deepEqual(normalized.quiet_hours, { enabled: true, start: "22:00", end: "07:00" })
})

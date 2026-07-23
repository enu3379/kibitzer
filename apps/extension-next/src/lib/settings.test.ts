import assert from "node:assert/strict"
import test from "node:test"

import { inQuietHours, type QuietHours } from "./settings.ts"

const at = (h: number, m = 0): number => new Date(2026, 0, 1, h, m, 0).getTime()

test("inQuietHours is false when disabled", () => {
  assert.equal(inQuietHours({ enabled: false, start: "22:00", end: "08:00" }, at(23)), false)
})

test("inQuietHours handles a window crossing midnight (22:00–08:00)", () => {
  const q: QuietHours = { enabled: true, start: "22:00", end: "08:00" }
  assert.equal(inQuietHours(q, at(23)), true)
  assert.equal(inQuietHours(q, at(7)), true)
  assert.equal(inQuietHours(q, at(22)), true) // start inclusive
  assert.equal(inQuietHours(q, at(8)), false) // end exclusive
  assert.equal(inQuietHours(q, at(12)), false)
})

test("inQuietHours handles a same-day window (09:00–17:00)", () => {
  const q: QuietHours = { enabled: true, start: "09:00", end: "17:00" }
  assert.equal(inQuietHours(q, at(12)), true)
  assert.equal(inQuietHours(q, at(8, 59)), false)
  assert.equal(inQuietHours(q, at(17)), false)
})

test("inQuietHours is false for a zero-length window", () => {
  assert.equal(inQuietHours({ enabled: true, start: "09:00", end: "09:00" }, at(9)), false)
})

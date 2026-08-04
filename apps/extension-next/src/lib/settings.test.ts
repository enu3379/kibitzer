import assert from "node:assert/strict"
import test from "node:test"

// chrome.storage.local stub for the getSettings/setSettings coercion tests below.
const store: Record<string, unknown> = {}
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
      remove: async (key: string) => void delete store[key],
    },
  },
}

import {
  DEFAULT_SETTINGS,
  SENSITIVITY_PRESETS,
  getSettings,
  inQuietHours,
  sensitivityLevelFor,
  setSettings,
  snapTauOk,
  type QuietHours,
} from "./settings.ts"

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

test("sensitivity presets are strictly ordered and the default is standard", () => {
  assert.ok(SENSITIVITY_PRESETS.lenient < SENSITIVITY_PRESETS.standard)
  assert.ok(SENSITIVITY_PRESETS.standard < SENSITIVITY_PRESETS.strict)
  assert.equal(SENSITIVITY_PRESETS.standard, 0.59) // O4 FPR-10% operating point (tier0.TAU_OK)
  assert.equal(DEFAULT_SETTINGS.tauOk, SENSITIVITY_PRESETS.standard)
  assert.equal(DEFAULT_SETTINGS.observeLocalPdfs, false, "local PDFs must be explicit opt-in")
  assert.equal(DEFAULT_SETTINGS.localPdfPolicyRevision, 0)
})

test("sessionAutoContinue defaults ON — including for legacy records that predate the field", async () => {
  assert.equal(DEFAULT_SETTINGS.sessionAutoContinue, true)

  // A settings record written before the field existed: Boolean(undefined) would silently
  // opt legacy users out of restart-continue; the coercion must default it to true instead.
  store["kibitzer:settings:v1"] = { tauOk: 0.59, observeLocalPdfs: true }
  assert.equal((await getSettings()).sessionAutoContinue, true)

  // The explicit OFF choice round-trips and survives an unrelated patch.
  await setSettings({ sessionAutoContinue: false })
  assert.equal((await getSettings()).sessionAutoContinue, false)
  await setSettings({ tauOk: SENSITIVITY_PRESETS.strict })
  assert.equal((await getSettings()).sessionAutoContinue, false)
  delete store["kibitzer:settings:v1"]
})

test("sensitivityLevelFor maps a tauOk to the nearest preset level", () => {
  assert.equal(sensitivityLevelFor(SENSITIVITY_PRESETS.lenient), "lenient")
  assert.equal(sensitivityLevelFor(SENSITIVITY_PRESETS.standard), "standard")
  assert.equal(sensitivityLevelFor(SENSITIVITY_PRESETS.strict), "strict")
  assert.equal(sensitivityLevelFor(0), "lenient")
  assert.equal(sensitivityLevelFor(0.61), "standard")
  assert.equal(sensitivityLevelFor(1), "strict")
})

test("snapTauOk folds legacy 0.01-step slider values onto preset values", () => {
  assert.equal(snapTauOk(0.4), SENSITIVITY_PRESETS.lenient) // old slider min
  assert.equal(snapTauOk(0.47), SENSITIVITY_PRESETS.lenient)
  assert.equal(snapTauOk(0.59), SENSITIVITY_PRESETS.standard)
  assert.equal(snapTauOk(0.62), SENSITIVITY_PRESETS.standard)
  assert.equal(snapTauOk(0.7), SENSITIVITY_PRESETS.strict)
  assert.equal(snapTauOk(0.8), SENSITIVITY_PRESETS.strict) // old slider max
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  listExplorationHistory,
  loadExplorationHistory,
  prependExplorationHistory,
  updateExplorationHistory,
  updateExplorationHistoryByObservationId,
} from "../src/lib/history.ts"

const HISTORY_STORAGE_KEY = "kibitzer:exploration-history"

function historyEntry(id, overrides = {}) {
  return {
    id,
    tabId: 1,
    url: `https://example.com/${id}`,
    title: `Page ${id}`,
    startedAt: 1_000,
    endedAt: 2_000,
    observationDwellMs: 5_000,
    tier2DwellMs: 10_000,
    observationId: `obs_${id}`,
    verdict: "DRIFT",
    ...overrides,
  }
}

function installSessionStorage(initialEntries = [], options = {}) {
  let entries = structuredClone(initialEntries)
  let rejectNextSet = options.rejectNextSet ?? false
  let rejectGet = options.rejectGet ?? false

  globalThis.chrome = {
    storage: {
      session: {
        async get() {
          await new Promise((resolve) => setImmediate(resolve))
          if (rejectGet) throw new Error("synthetic get failure")
          return { [HISTORY_STORAGE_KEY]: structuredClone(entries) }
        },
        async set(values) {
          await new Promise((resolve) => setImmediate(resolve))
          if (rejectNextSet) {
            rejectNextSet = false
            throw new Error("synthetic set failure")
          }
          entries = structuredClone(values[HISTORY_STORAGE_KEY])
        },
      },
    },
  }

  return {
    entries: () => structuredClone(entries),
  }
}

test("serializes concurrent prepends without losing either entry", async () => {
  const storage = installSessionStorage()

  await Promise.all([
    prependExplorationHistory(historyEntry("first")),
    prependExplorationHistory(historyEntry("second")),
  ])

  assert.deepEqual(
    storage.entries().map((entry) => entry.id),
    ["second", "first"],
  )
})

test("serializes prepend and update mutations on the same storage key", async () => {
  const storage = installSessionStorage([historyEntry("existing")])

  await Promise.all([
    prependExplorationHistory(historyEntry("new")),
    updateExplorationHistory("existing", { responseKind: "intervention" }),
  ])

  assert.deepEqual(
    storage.entries().map((entry) => [entry.id, entry.responseKind]),
    [
      ["new", undefined],
      ["existing", "intervention"],
    ],
  )
})

test("serializes multiple updates without dropping earlier patches", async () => {
  const storage = installSessionStorage([historyEntry("existing")])

  await Promise.all([
    updateExplorationHistory("existing", { title: "Updated title" }),
    updateExplorationHistory("existing", { responseKind: "celebration" }),
  ])

  assert.equal(storage.entries()[0].title, "Updated title")
  assert.equal(storage.entries()[0].responseKind, "celebration")
})

test("serializes response markers and verdict corrections for one observation", async () => {
  const storage = installSessionStorage([historyEntry("existing")])

  await Promise.all([
    updateExplorationHistory("existing", { responseKind: "intervention" }),
    updateExplorationHistoryByObservationId("obs_existing", { verdict: "OK" }),
  ])

  assert.equal(storage.entries()[0].responseKind, "intervention")
  assert.equal(storage.entries()[0].verdict, "OK")
})

test("continues processing mutations after a rejected write", async () => {
  const storage = installSessionStorage([], { rejectNextSet: true })

  await assert.rejects(prependExplorationHistory(historyEntry("failed")), /synthetic set failure/)
  await prependExplorationHistory(historyEntry("recovered"))

  assert.deepEqual(
    storage.entries().map((entry) => entry.id),
    ["recovered"],
  )
})

test("filters entries with missing or mistyped required fields", async () => {
  const requiredFields = [
    "id",
    "url",
    "title",
    "startedAt",
    "observationDwellMs",
    "tier2DwellMs",
  ]
  const fixtures = []

  for (const field of requiredFields) {
    const missing = historyEntry(`missing-${field}`)
    delete missing[field]
    fixtures.push(missing)
    fixtures.push(historyEntry(`wrong-${field}`, { [field]: null }))
  }
  fixtures.push(historyEntry("valid"))
  installSessionStorage(fixtures)

  const entries = await listExplorationHistory()

  assert.deepEqual(entries.map((entry) => entry.id), ["valid"])
})

test("filters mistyped optional fields while keeping valid optional values", async () => {
  installSessionStorage([
    historyEntry("bad-tab", { tabId: "1" }),
    historyEntry("bad-ended", { endedAt: "later" }),
    historyEntry("bad-observation", { observationId: 3 }),
    historyEntry("bad-verdict", { verdict: "UNKNOWN" }),
    historyEntry("bad-response", { responseKind: "toast" }),
    historyEntry("bad-number", { tier2DwellMs: Number.NaN }),
    historyEntry("valid", { responseKind: "celebration" }),
  ])

  const entries = await listExplorationHistory()

  assert.deepEqual(entries.map((entry) => entry.id), ["valid"])
  assert.equal(entries[0].responseKind, "celebration")
})

test("returns a non-sensitive failure result when history storage rejects", async () => {
  installSessionStorage([], { rejectGet: true })

  const loaded = await loadExplorationHistory()

  assert.deepEqual(loaded, { ok: false })
})

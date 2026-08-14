// User-editable domain lists: entry normalization (bare hosts only), versioned persistence
// in chrome.storage.local, and the synchronous-gate cache (loaded by initDomainLists,
// refreshed via storage.onChanged and the explicit setter). Storage is stubbed in-memory
// following session.test.ts, plus a minimal onChanged so the refresh path is exercised.

import assert from "node:assert/strict"
import test from "node:test"

const store: Record<string, unknown> = {}
type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void
const changeListeners: ChangeListener[] = []
;(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    onChanged: { addListener: (fn: ChangeListener) => changeListeners.push(fn) },
    local: {
      get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
      remove: async (key: string) => void delete store[key],
    },
  },
}

const { getDomainLists, initDomainLists, normalizeHostEntry, setDomainLists } = await import("./domainLists.ts")
const { isUserAllowedUrl, setUserDomainLists, shouldDropUrl } = await import("./domainFilter.ts")

const KEY = "kibitzer:domain-lists:v1"

test("normalizeHostEntry strips scheme/path/port/wildcard/whitespace down to a bare host", () => {
  assert.equal(normalizeHostEntry("instagram.com"), "instagram.com")
  assert.equal(normalizeHostEntry("  HTTPS://Instagram.com/reels?x=1#top  "), "instagram.com")
  assert.equal(normalizeHostEntry("www.YouTube.com:443/watch"), "www.youtube.com")
  assert.equal(normalizeHostEntry("user:pass@example.com/path"), "example.com")
  assert.equal(normalizeHostEntry("*.instagram.com"), "instagram.com") // suffix match already covers subdomains
  assert.equal(normalizeHostEntry("instagram.com."), "instagram.com")
  assert.equal(normalizeHostEntry("127.0.0.1"), "127.0.0.1")
  assert.equal(normalizeHostEntry("localhost"), "localhost")
})

test("normalizeHostEntry rejects garbage gracefully", () => {
  assert.equal(normalizeHostEntry(""), null)
  assert.equal(normalizeHostEntry("   "), null)
  assert.equal(normalizeHostEntry("not a host"), null)
  assert.equal(normalizeHostEntry("https://"), null)
  assert.equal(normalizeHostEntry("///"), null)
  assert.equal(normalizeHostEntry("-bad.com"), null) // leading hyphen label
  assert.equal(normalizeHostEntry("bad-.com"), null) // trailing hyphen label
  assert.equal(normalizeHostEntry("a,b.com"), null) // URL parser lets commas through — we don't
})

test("setDomainLists persists normalized, deduped lists and reports rejected entries", async () => {
  for (const k of Object.keys(store)) delete store[k]
  const res = await setDomainLists({
    block: ["https://Instagram.com/reels", "instagram.com", "not a host", "   "],
    allow: ["Docs.Python.org", "*.python.org"],
  })
  assert.deepEqual(res.lists.block, ["instagram.com"]) // URL form folded onto the bare host
  assert.deepEqual(res.lists.allow, ["docs.python.org", "python.org"])
  assert.deepEqual(res.rejected, ["not a host"]) // blank entries are skipped silently, not rejected
  assert.deepEqual(await getDomainLists(), res.lists)
  assert.deepEqual(store[KEY], res.lists) // versioned key actually written
})

test("a partial set patches one list and keeps the other", async () => {
  for (const k of Object.keys(store)) delete store[k]
  await setDomainLists({ block: ["instagram.com"], allow: ["python.org"] })
  const res = await setDomainLists({ allow: ["python.org", "developer.mozilla.org"] })
  assert.deepEqual(res.lists, { block: ["instagram.com"], allow: ["python.org", "developer.mozilla.org"] })
})

test("setDomainLists feeds the synchronous gate immediately", async () => {
  for (const k of Object.keys(store)) delete store[k]
  await setDomainLists({ block: ["instagram.com"], allow: ["python.org"] })
  assert.equal(shouldDropUrl("https://www.instagram.com/"), true)
  assert.equal(isUserAllowedUrl("https://docs.python.org/3/"), true)
  await setDomainLists({ block: [], allow: [] })
  assert.equal(shouldDropUrl("https://www.instagram.com/"), false)
  assert.equal(isUserAllowedUrl("https://docs.python.org/3/"), false)
})

test("initDomainLists loads stored lists into the gate; storage.onChanged refreshes it", async () => {
  for (const k of Object.keys(store)) delete store[k]
  store[KEY] = { block: ["reddit.com"], allow: [] }
  setUserDomainLists({ block: [], allow: [] }) // simulate a fresh worker: cache empty
  await initDomainLists()
  assert.equal(shouldDropUrl("https://reddit.com/r/all"), true, "stored blocklist loaded at init")
  // Another context rewrites storage → the registered listener refreshes the cache.
  assert.ok(changeListeners.length > 0, "initDomainLists registered an onChanged listener")
  const fire = (changes: Record<string, { newValue?: unknown }>, area: string): void =>
    changeListeners.forEach((fn) => fn(changes, area))
  fire({ [KEY]: { newValue: { block: [], allow: ["reddit.com"] } } }, "local")
  assert.equal(shouldDropUrl("https://reddit.com/r/all"), false)
  assert.equal(isUserAllowedUrl("https://reddit.com/r/all"), true)
  // Unrelated keys / areas are ignored.
  fire({ "kibitzer:settings:v1": { newValue: {} } }, "local")
  fire({ [KEY]: { newValue: { block: ["reddit.com"], allow: [] } } }, "sync")
  assert.equal(isUserAllowedUrl("https://reddit.com/r/all"), true, "unrelated change left the cache alone")
})

test("stored garbage is coerced defensively on read", async () => {
  store[KEY] = { block: [42, "ok.example", "///", "dup.example", "dup.example"], allow: "nope" }
  assert.deepEqual(await getDomainLists(), { block: ["ok.example", "dup.example"], allow: [] })
})

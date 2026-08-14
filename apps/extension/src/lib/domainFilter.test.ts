// The privacy gate with the user-editable lists merged in (options 사이트 pane): user block
// entries behave exactly like the static sensitive list, allow entries mark always-on-goal
// hosts, and the blocklist — static or user — always wins over the allowlist. Pure module:
// no chrome stub needed; the cache is reset per test via setUserDomainLists.

import assert from "node:assert/strict"
import test from "node:test"

import { isUserAllowedUrl, isUserBlockedUrl, setUserDomainLists, shouldDropUrl } from "./domainFilter.ts"

const reset = (): void => setUserDomainLists({ block: [], allow: [] })

test("the static sensitive list still drops with empty user lists (never weakened)", () => {
  reset()
  assert.equal(shouldDropUrl("https://chase.com/account/summary"), true)
  assert.equal(shouldDropUrl("https://online.mybank.example/"), true) // "bank" keyword
  assert.equal(shouldDropUrl("https://example.com/article"), false)
})

test("a user-blocked host drops — exact host and subdomains, not lookalike suffixes", () => {
  reset()
  setUserDomainLists({ block: ["instagram.com"], allow: [] })
  assert.equal(shouldDropUrl("https://instagram.com/reels"), true)
  assert.equal(shouldDropUrl("https://www.instagram.com/"), true)
  assert.equal(shouldDropUrl("https://notinstagram.com/"), false) // label boundary required
  assert.equal(shouldDropUrl("https://example.com/instagram.com"), false) // host, not path
  assert.equal(isUserBlockedUrl("https://www.instagram.com/"), true)
  assert.equal(isUserBlockedUrl("https://chase.com/"), false) // static drop, not the user's
})

test("URL-side host casing never bypasses the user lists", () => {
  reset()
  setUserDomainLists({ block: ["instagram.com"], allow: ["python.org"] })
  assert.equal(shouldDropUrl("https://WWW.INSTAGRAM.COM/x"), true)
  assert.equal(isUserAllowedUrl("https://DOCS.PYTHON.ORG/3/"), true)
})

test("the user allowlist marks a host always-on-goal — exact host and subdomains", () => {
  reset()
  setUserDomainLists({ block: [], allow: ["python.org"] })
  assert.equal(isUserAllowedUrl("https://docs.python.org/3/tutorial/"), true)
  assert.equal(isUserAllowedUrl("https://python.org/"), true)
  assert.equal(isUserAllowedUrl("https://notpython.org/"), false)
  assert.equal(isUserAllowedUrl("https://example.com/"), false)
  // Allowlisting must not make anything droppable.
  assert.equal(shouldDropUrl("https://docs.python.org/3/tutorial/"), false)
})

test("the USER blocklist wins over the allowlist when both match", () => {
  reset()
  setUserDomainLists({ block: ["instagram.com"], allow: ["instagram.com"] })
  assert.equal(shouldDropUrl("https://instagram.com/"), true)
  assert.equal(isUserAllowedUrl("https://instagram.com/"), false)
  assert.equal(isUserAllowedUrl("https://www.instagram.com/"), false)
})

test("the STATIC blocklist also wins over the user allowlist", () => {
  reset()
  setUserDomainLists({ block: [], allow: ["chase.com", "online.mybank.example"] })
  assert.equal(isUserAllowedUrl("https://chase.com/account"), false) // static blocked host
  assert.equal(isUserAllowedUrl("https://online.mybank.example/"), false) // "bank" keyword
})

test("fail-closed on bad URLs: always dropped, never allowed", () => {
  reset()
  setUserDomainLists({ block: [], allow: ["example.com"] })
  assert.equal(shouldDropUrl("not a url"), true)
  assert.equal(shouldDropUrl(""), true)
  assert.equal(isUserAllowedUrl("not a url"), false)
  assert.equal(isUserAllowedUrl(""), false)
  // A parse failure is not attributed to the user list (the drop path logs it as sensitive).
  assert.equal(isUserBlockedUrl("not a url"), false)
})

test("setUserDomainLists replaces the cache — stale entries do not linger", () => {
  reset()
  setUserDomainLists({ block: ["reddit.com"], allow: ["python.org"] })
  assert.equal(shouldDropUrl("https://reddit.com/r/all"), true)
  setUserDomainLists({ block: [], allow: [] })
  assert.equal(shouldDropUrl("https://reddit.com/r/all"), false)
  assert.equal(isUserAllowedUrl("https://python.org/"), false)
})

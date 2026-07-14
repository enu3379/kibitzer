import assert from "node:assert/strict"
import test from "node:test"

import { shouldDropUrl } from "../src/lib/domainFilter.ts"

test("drops malformed, exact, subdomain, path, and keyword-sensitive URLs", () => {
  const blocked = [
    "not a url",
    "https://paypal.com/checkout",
    "https://secure.mail.google.com/inbox",
    "https://github.com/settings/security",
    "https://secure-login.example.com/account",
    "http://127.0.0.1:8765/health",
  ]

  for (const url of blocked) {
    assert.equal(shouldDropUrl(url), true, url)
  }
})

test("allows unrelated hosts and does not confuse host suffixes or paths", () => {
  const allowed = [
    "https://example.com/articles/payment-history",
    "https://github.com/openai/codex",
    "https://paypal.com.evil.example/checkout",
    "https://example.com/settings",
  ]

  for (const url of allowed) {
    assert.equal(shouldDropUrl(url), false, url)
  }
})

test("matches blocked hosts and paths case-insensitively", () => {
  assert.equal(shouldDropUrl("HTTPS://GITHUB.COM/SETTINGS/PROFILE"), true)
  assert.equal(shouldDropUrl("HTTPS://MAIL.GOOGLE.COM/MAIL/U/0"), true)
})

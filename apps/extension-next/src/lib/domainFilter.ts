// Privacy gate: sensitive URLs (banking, webmail, health, auth, localhost) must never be
// observed, embedded, sent to the LLM, or nagged on. Ported verbatim from the old
// extension (apps/extension/src/lib/domainFilter.ts); reads the shared config so the
// blocklist stays single-sourced with the server (apps/server/app/privacy/domain_filter.py).

import sensitiveDomainRules from "../../../../configs/sensitive_domains.json" with { type: "json" }

const BLOCKED_HOSTS = sensitiveDomainRules.blocked_hosts
const BLOCKED_HOST_KEYWORDS = sensitiveDomainRules.blocked_host_keywords

// User-editable lists (options 사이트 pane) merge into this same gate so every capture path
// that consults shouldDropUrl — observation entry, excerpt extraction, exemplar learning,
// toast delivery — honors them automatically. Kept in a module-level cache because the gate
// must stay synchronous; domainLists.ts loads it at service-worker startup and refreshes it
// on storage changes. The static list above is never weakened: user entries only ADD drops.
let userBlockedHosts: readonly string[] = []
let userAllowedHosts: readonly string[] = []

/** Replace the in-memory user lists (normalized bare hosts — see domainLists.ts). */
export function setUserDomainLists(lists: { block: readonly string[]; allow: readonly string[] }): void {
  userBlockedHosts = [...lists.block]
  userAllowedHosts = [...lists.allow]
}

export function shouldDropUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return true
  }

  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase() || "/"

  for (const entry of [...BLOCKED_HOSTS].sort((a, b) => b.length - a.length)) {
    const [blockedHost, blockedPath] = splitHostPath(entry)
    if (hostMatches(host, blockedHost) && (!blockedPath || path.startsWith(blockedPath))) {
      return true
    }
  }

  if (BLOCKED_HOST_KEYWORDS.some((keyword) => host.includes(keyword))) return true
  return userBlockedHosts.some((blocked) => hostMatches(host, blocked))
}

/** True only for the USER blocklist (host-only matching). Used by the drop path to decide
 *  whether the log line must stay host-free — a user-blocked page must leave no trace of
 *  which page it was, while the static sensitive drop keeps its pageKey for debuggability.
 *  Parse failure → false: the caller has already dropped via shouldDropUrl's fail-closed
 *  branch, and the failure is not attributable to the user list. */
export function isUserBlockedUrl(rawUrl: string): boolean {
  const host = hostnameOf(rawUrl)
  return host != null && userBlockedHosts.some((blocked) => hostMatches(host, blocked))
}

/** True iff the user allowlist marks this URL always-on-goal (exact host or subdomain).
 *  The blocklist — static sensitive rules AND the user blocklist — always wins: a host that
 *  any drop rule matches is never "allowed". Fail-closed: an unparseable URL is never
 *  allowed either. */
export function isUserAllowedUrl(rawUrl: string): boolean {
  const host = hostnameOf(rawUrl)
  if (host == null) return false
  if (shouldDropUrl(rawUrl)) return false // blocklist (static or user) wins over allowlist
  return userAllowedHosts.some((allowed) => hostMatches(host, allowed))
}

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

function splitHostPath(entry: string): [string, string | null] {
  const slash = entry.indexOf("/")
  if (slash === -1) return [entry, null]
  return [entry.slice(0, slash), entry.slice(slash)]
}

function hostMatches(host: string, blockedHost: string): boolean {
  return host === blockedHost || host.endsWith(`.${blockedHost}`)
}

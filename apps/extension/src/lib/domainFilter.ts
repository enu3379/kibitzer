import sensitiveDomainRules from "../../../../configs/sensitive_domains.json" with { type: "json" }

const BLOCKED_HOSTS = sensitiveDomainRules.blocked_hosts
const BLOCKED_HOST_KEYWORDS = sensitiveDomainRules.blocked_host_keywords

export function shouldDropUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return true
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true

  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase() || "/"

  for (const entry of [...BLOCKED_HOSTS].sort((a, b) => b.length - a.length)) {
    const [blockedHost, blockedPath] = splitHostPath(entry)
    if (hostMatches(host, blockedHost) && (!blockedPath || path.startsWith(blockedPath))) {
      return true
    }
  }

  return BLOCKED_HOST_KEYWORDS.some((keyword) => host.includes(keyword))
}

function splitHostPath(entry: string): [string, string | null] {
  const slash = entry.indexOf("/")
  if (slash === -1) return [entry, null]
  return [entry.slice(0, slash), entry.slice(slash)]
}

function hostMatches(host: string, blockedHost: string): boolean {
  return host === blockedHost || host.endsWith(`.${blockedHost}`)
}

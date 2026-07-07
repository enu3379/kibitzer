const BLOCKED_HOSTS = [
  "accounts.google.com",
  "myaccount.google.com",
  "bankofamerica.com",
  "chase.com",
  "paypal.com",
  "stripe.com",
  "checkout.stripe.com",
  "docs.google.com",
  "drive.google.com",
  "mail.google.com",
  "github.com/settings",
  "localhost",
  "127.0.0.1",
]

const BLOCKED_HOST_KEYWORDS = [
  "bank",
  "billing",
  "checkout",
  "payment",
  "password",
  "patient",
  "medical",
  "health",
  "auth",
  "login",
]

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

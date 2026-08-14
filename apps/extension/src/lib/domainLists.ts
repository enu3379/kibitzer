// User-editable domain filter lists (options 사이트 pane), persisted in chrome.storage.local
// under a versioned key (same convention as settings.ts). Two lists of bare hosts:
//   - block: pages the extension must NEVER observe — merged into domainFilter's
//     shouldDropUrl, so they behave exactly like the built-in sensitive-domain list
//     (no dwell, no judging, no records, gauge held NEUTRAL);
//   - allow: hosts that are always on-goal — background's judge short-circuits them to OK
//     before the Tier-0 embed (no LLM spend, S recovers).
// The gate itself (domainFilter) is synchronous, so this module mirrors the lists into its
// in-memory cache: loaded once per service-worker lifetime (memoized initDomainLists),
// refreshed by storage.onChanged and by the explicit setDomainLists path.

import { setUserDomainLists } from "./domainFilter.ts"

const DOMAIN_LISTS_KEY = "kibitzer:domain-lists:v1"

export interface DomainLists {
  block: string[]
  allow: string[]
}

export interface SetDomainListsResult {
  lists: DomainLists
  rejected: string[] // raw entries that were not valid hosts — reported to the UI, never persisted
}

/** Normalize one user-typed entry to a bare lowercase host, or null if it isn't one.
 *  Accepts "instagram.com", " HTTPS://Instagram.com/reels?x=1 ", "host:8080", "*.host" —
 *  scheme, path/query/fragment, credentials, port, a subdomain wildcard, and whitespace are
 *  all stripped (user lists are host-only; suffix matching already covers subdomains).
 *  IDN entries are folded to punycode via the URL parser, matching what tab URLs report. */
export function normalizeHostEntry(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme
  s = s.split(/[/?#\\]/, 1)[0] // path / query / fragment
  s = s.slice(s.lastIndexOf("@") + 1) // credentials
  s = s.replace(/^\*\./, "").replace(/^\./, "") // "*.host" / ".host" → host
  s = s.replace(/\.$/, "") // trailing root dot (URL would preserve it)
  if (!s) return null
  let parsed: URL
  try {
    parsed = new URL(`https://${s}`) // canonicalizes (punycode, port strip) and rejects much garbage
  } catch {
    return null
  }
  const host = parsed.hostname
  // The URL parser is lenient (commas, underscores, … survive) — require a plausible
  // hostname shape on top: dot-separated labels of [a-z0-9-], no edge hyphens.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null
  return host
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const host = normalizeHostEntry(entry)
    if (host && !out.includes(host)) out.push(host)
  }
  return out
}

/** Defensive coercion — hand-edited or legacy storage never widens the shape. */
function coerce(value: unknown): DomainLists {
  const v = value as Partial<Record<keyof DomainLists, unknown>> | undefined
  return { block: cleanList(v?.block), allow: cleanList(v?.allow) }
}

export async function getDomainLists(): Promise<DomainLists> {
  const stored = await chrome.storage.local.get(DOMAIN_LISTS_KEY)
  return coerce(stored[DOMAIN_LISTS_KEY])
}

/** Persist the lists (normalized + deduped) and refresh the sync gate cache in this worker.
 *  Blank entries are skipped silently; non-host entries are dropped and reported back in
 *  `rejected` so the options UI can tell the user what was ignored. */
export async function setDomainLists(input: { block?: string[]; allow?: string[] }): Promise<SetDomainListsResult> {
  const current = await getDomainLists()
  const rejected: string[] = []
  const parse = (raws: string[] | undefined, fallback: string[]): string[] => {
    if (!raws) return fallback
    const out: string[] = []
    for (const raw of raws) {
      if (typeof raw !== "string" || !raw.trim()) continue
      const host = normalizeHostEntry(raw)
      if (!host) rejected.push(raw.trim())
      else if (!out.includes(host)) out.push(host)
    }
    return out
  }
  const lists: DomainLists = { block: parse(input.block, current.block), allow: parse(input.allow, current.allow) }
  await chrome.storage.local.set({ [DOMAIN_LISTS_KEY]: lists })
  setUserDomainLists(lists) // immediate same-worker refresh (onChanged also fires, harmlessly)
  return { lists, rejected }
}

let ready: Promise<void> | null = null

/** Load the stored lists into domainFilter's synchronous cache. Memoized per service-worker
 *  lifetime — the first call does the storage read and registers the storage.onChanged
 *  refresh; every later `await` resolves instantly, so hot-path callers can await it as a
 *  cheap readiness barrier. onChanged is optional-chained: absent in the unit/e2e chrome
 *  mocks, always present in real Chrome. */
export function initDomainLists(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !(DOMAIN_LISTS_KEY in changes)) return
      setUserDomainLists(coerce(changes[DOMAIN_LISTS_KEY].newValue))
    })
    setUserDomainLists(await getDomainLists())
  })()
  return ready
}

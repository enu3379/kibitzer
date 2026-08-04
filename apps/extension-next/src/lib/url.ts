// Shared URL helpers used by the observation surface (background) and the Tier-2 gate
// (gaugeRuntime), so both derive the page identity the same way.

/** A fast, deterministic, non-cryptographic 53-bit string hash (cyrb53). Used to fold a
 *  URL's path+query into a compact opaque token: the raw path — which can carry PII like
 *  `/user/123/secret-doc` — is never stored, while pages that differ only by query stay
 *  distinct. (Not a security primitive; a crypto-grade SHA-256 would require making pageKeyOf
 *  async, which ripples through the whole synchronous observation path.) */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(36)
}

export type ObservablePageKind = "web" | "local_pdf"

export interface ObservablePageDescriptor {
  kind: ObservablePageKind
  pageKey: string
  urlHost: string
}

/** Describe URLs Kibitzer may observe. Local-file support is deliberately limited to PDFs:
 *  other file:// pages remain internal/unobservable. The raw local path is used only as the
 *  in-memory hash input and must never be persisted or logged. */
export function describeObservableUrl(url: string): ObservablePageDescriptor | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return {
        kind: "web",
        pageKey: `${parsed.host}#${cyrb53(parsed.pathname + parsed.search)}`,
        urlHost: parsed.hostname,
      }
    }
    if (parsed.protocol === "file:" && parsed.pathname.toLowerCase().endsWith(".pdf")) {
      return {
        kind: "local_pdf",
        // Include an opaque UNC authority in the hash input so identical share paths on two
        // file servers do not collide; the authority itself is never persisted or logged.
        pageKey: `local-pdf#${cyrb53(parsed.host + parsed.pathname + parsed.search)}`,
        urlHost: "local-pdf",
      }
    }
    return null
  } catch {
    return null
  }
}

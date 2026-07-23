// Shared URL helpers used by the observation surface (background) and the Tier-2 gate
// (gaugeRuntime), so both derive the page identity the same way.

/** Stable per-page key (host + path), or null for non-http(s) URLs. */
export function pageKeyOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return null
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

// Friendly display names for well-known hosts, so the session report can say
// "📷 인스타그램 5번" instead of "instagram.com". Pure; unknown hosts fall back to the
// bare host (www./m. stripped) with no emoji. Matched by registrable domain suffix, so
// www.instagram.com and m.youtube.com resolve too.

export interface FriendlyHost {
  emoji: string // "" for unknown hosts
  name: string
}

// Keyed by registrable domain. Ordered roughly by how often they show up as time-sinks.
const KNOWN: Record<string, FriendlyHost> = {
  "instagram.com": { emoji: "📷", name: "인스타그램" },
  "youtube.com": { emoji: "▶️", name: "유튜브" },
  "x.com": { emoji: "✖️", name: "X" },
  "twitter.com": { emoji: "✖️", name: "X" },
  "facebook.com": { emoji: "📘", name: "페이스북" },
  "threads.net": { emoji: "🧵", name: "스레드" },
  "tiktok.com": { emoji: "🎵", name: "틱톡" },
  "reddit.com": { emoji: "👽", name: "레딧" },
  "netflix.com": { emoji: "🎬", name: "넷플릭스" },
  "twitch.tv": { emoji: "🎮", name: "트위치" },
  "chzzk.naver.com": { emoji: "🎮", name: "치지직" },
  "dcinside.com": { emoji: "🗯️", name: "디시인사이드" },
  "fmkorea.com": { emoji: "🗯️", name: "에펨코리아" },
  "theqoo.net": { emoji: "🗯️", name: "더쿠" },
  "ruliweb.com": { emoji: "🗯️", name: "루리웹" },
  "clien.net": { emoji: "🗯️", name: "클리앙" },
  "inven.co.kr": { emoji: "🎮", name: "인벤" },
  "arca.live": { emoji: "🗯️", name: "아카라이브" },
  "coupang.com": { emoji: "🛒", name: "쿠팡" },
  "aliexpress.com": { emoji: "🛒", name: "알리익스프레스" },
  "amazon.com": { emoji: "🛒", name: "아마존" },
  "musinsa.com": { emoji: "🛒", name: "무신사" },
}

/** Strip a trailing FQDN dot and a leading www./m. label so "www.instagram.com." and the
 *  bare domain agree. */
function stripCommonSub(host: string): string {
  return host.replace(/\.$/, "").replace(/^(www|m|mobile)\./i, "")
}

export function friendlyHost(host: string | null | undefined): FriendlyHost {
  const clean = stripCommonSub((host ?? "").trim().toLowerCase())
  if (!clean) return { emoji: "", name: "알 수 없는 사이트" }
  for (const domain of Object.keys(KNOWN)) {
    // Return a copy — callers must never mutate the shared KNOWN entry.
    if (clean === domain || clean.endsWith(`.${domain}`)) return { ...KNOWN[domain] }
  }
  return { emoji: "", name: clean }
}

/** "📷 인스타그램" / "instagram.com" (unknown) — the friendly label as one string. */
export function friendlyLabel(host: string | null | undefined): string {
  const f = friendlyHost(host)
  return f.emoji ? `${f.emoji} ${f.name}` : f.name
}

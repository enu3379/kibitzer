// Cross-lingual goal enrichment: expand the declared goal into short search-style phrases
// (roughly half in the page's likely language for tech/gaming/research), embed them, and
// keep them as Tier-0 "derived" exemplars so a terse goal like "리팩터링" still matches an
// English page titled "extract method pattern". Faithful port of the server's
// apps/server/app/core/goal_enrichment.py (prompt, lenient parse, dedup filter).

export const MAX_PHRASES = 8
export const ENRICH_TIMEOUT_MS = 20_000

export interface DerivedPhrase {
  phrase: string
  vector: number[]
}

// Verbatim from the server GOAL_ENRICHMENT_PROMPT (JSON braces are literal here).
export function buildEnrichmentPrompt(goalText: string, maxPhrases: number): string {
  return `You expand a user's declared browsing goal into short search-style phrases.
The phrases seed a local semantic matcher (embedding cosine similarity) that
decides whether a browser tab title is related to the goal, so each phrase
must read like something that could plausibly be the title of a related page.

Declared goal (verbatim): "${goalText}"

Return strict JSON only: {"phrases": ["...", "..."]}

Rules:
- At most ${maxPhrases} phrases.
- Each phrase 2-6 words, content-bearing, specific to this goal's subject.
- Cover DISTINCT aspects (actions, tools, entities, synonyms, adjacent
  sub-tasks) — not rewordings of one phrase.
- If pages about this topic are commonly in another language (software,
  gaming, tech, research → English), write roughly half the phrases in that
  language.
- NEVER output: bare platform/site names (YouTube, Google, 나무위키, Reddit),
  bare generic activity words (검색, 리뷰, 정리, 공략, tutorial, guide —
  allowed only when tightly bound to a goal-specific noun), or single common
  words.
- Test each phrase: if this phrase alone appeared in a page title, would that
  page almost certainly be about the goal? If not, drop it.

Example — goal "국내 여행지 탐색":
{"phrases": ["국내 여행지 추천 코스", "제주 부산 강릉 여행", "국내 숙소 예약 비교", "당일치기 근교 여행", "domestic Korea travel itinerary"]}
`
}

/** Lenient JSON extraction (models wrap the object in thinking preambles / code fences),
 *  matching the judges' _load_json_object. Returns up to maxPhrases string phrases. */
export function parseEnrichmentResponse(content: string, maxPhrases: number): string[] {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    const start = content.indexOf("{")
    const end = content.lastIndexOf("}")
    if (start === -1 || end <= start) throw new Error("no JSON object in enrichment response")
    data = JSON.parse(content.slice(start, end + 1))
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("goal enrichment response must be a JSON object")
  }
  const phrases = (data as { phrases?: unknown }).phrases
  if (!Array.isArray(phrases)) throw new Error("goal enrichment response must include phrases")
  return phrases.filter((p): p is string => typeof p === "string").slice(0, maxPhrases)
}

function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

/** Normalize/dedup the phrases (2–8 tokens, ≠ goal), embed them, and drop near-duplicates
 *  (cosine > 0.95). `embed` batch-embeds and returns L2-normalized vectors. */
export async function filterDerivedPhrases(
  phrases: string[],
  goalText: string,
  maxPhrases: number,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<DerivedPhrase[]> {
  const normalizedGoal = goalText.trim().split(/\s+/u).join(" ").toLowerCase()
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const raw of phrases.slice(0, maxPhrases)) {
    const normalized = String(raw).trim().split(/\s+/u).filter(Boolean).join(" ")
    if (!normalized) continue
    const tokenCount = normalized.split(" ").length
    if (tokenCount < 2 || tokenCount > 8) continue
    const key = normalized.toLowerCase()
    if (key === normalizedGoal || seen.has(key)) continue
    seen.add(key)
    candidates.push(normalized)
  }
  if (candidates.length === 0) return []

  const vectors = await embed(candidates)
  const kept: DerivedPhrase[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const vector = vectors[i]
    if (!vector) continue
    if (kept.some((existing) => dot(vector, existing.vector) > 0.95)) continue
    kept.push({ phrase: candidates[i], vector })
  }
  return kept
}

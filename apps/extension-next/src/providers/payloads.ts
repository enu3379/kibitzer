import type { Tier2Decision } from "./types.ts"

export interface Tier1Goal {
  rawText: string
  derivedPhrases?: readonly string[]
}

export interface Tier1Observation {
  title?: string | null
  urlHost?: string | null
}

export interface RecentTitle {
  title?: string | null
  verdict?: string | null
}

export interface Tier1PayloadOptions {
  title?: boolean
  urlHost?: boolean
  recentTitles?: boolean
}

export interface Tier2Goal {
  rawText: string
}

export interface Tier2Observation {
  title?: string | null
  urlHost?: string | null
  verdict?: string | null
  tierReached?: number | null
  tier0Score?: number | null
}

export interface RecentContent {
  title?: string | null
  verdict?: string | null
  text?: string | null
}

export interface Tier2ReviewOptions {
  excerptCharLimit?: number
}

export function buildTier1Payload(
  goal: Tier1Goal,
  observation: Tier1Observation,
  recent: readonly RecentTitle[],
  options: Tier1PayloadOptions = {},
): Record<string, unknown> {
  const send = {
    title: options.title ?? true,
    urlHost: options.urlHost ?? true,
    recentTitles: options.recentTitles ?? true,
  }
  const current: Record<string, unknown> = {}
  if (send.title) current.title = observation.title ?? ""
  if (send.urlHost) current.url_host = observation.urlHost ?? ""

  const payload: Record<string, unknown> = {
    goal: goal.rawText,
    current,
  }
  if (goal.derivedPhrases?.length) {
    payload["goal.derived_phrases"] = [...goal.derivedPhrases]
  }
  if (send.recentTitles) {
    payload.recent = recent
      .filter((item) => item.title || item.verdict)
      .map((item) => ({
        title: item.title ?? "",
        verdict: item.verdict ?? "",
      }))
  }
  return payload
}

export function buildTier2ReviewPayload(
  goal: Tier2Goal,
  observation: Tier2Observation,
  recentTitles: readonly RecentTitle[],
  currentExcerpt: string | null,
  recentContent: readonly RecentContent[],
  timeContext: Record<string, unknown> | null,
  options: Tier2ReviewOptions = {},
): Record<string, unknown> {
  const excerptCharLimit = options.excerptCharLimit ?? 3000
  const cleanedExcerpt = cleanExcerpt(currentExcerpt ?? "", excerptCharLimit)
  const payload: Record<string, unknown> = {
    review_kind: "combined",
    goal: goal.rawText,
    current: {
      title: observation.title ?? null,
      url_host: observation.urlHost ?? null,
      verdict: observation.verdict ?? null,
      tier_reached: observation.tierReached ?? null,
      tier0_score: observation.tier0Score ?? null,
      page_excerpt: cleanedExcerpt || null,
    },
    recent_titles: compressRecentTitles(recentTitles),
    recent_pages: recentContent
      .filter((item) => item.text)
      .map((item) => ({
        title: item.title ?? null,
        verdict: item.verdict ?? null,
        page_excerpt: item.text,
      })),
    repeat_signals: {
      current_title_recent_visits: recentTitles.filter(
        (item) => Boolean(observation.title) && item.title === observation.title,
      ).length,
    },
  }
  if (timeContext !== null) payload.time_budget = timeContext
  return payload
}

export function buildTier2MessagePayload(
  goal: Tier2Goal,
  observation: Tier2Observation,
  decision: Tier2Decision,
  timeContext: Record<string, unknown> | null,
  naggingContext: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    goal: goal.rawText,
    current: {
      title: observation.title ?? null,
      url_host: observation.urlHost ?? null,
    },
    judgment: {
      decision: decision.decision,
      reason_code: decision.reasonCode,
      basis: decision.basis,
    },
    nagging_context: naggingContext,
  }
  if (timeContext !== null) payload.time_budget = timeContext
  return payload
}

export function compressRecentTitles(
  recent: readonly RecentTitle[],
): Array<Record<string, unknown>> {
  const compressed: Array<{
    title: string | null
    verdict: string | null
    repeat_count: number
  }> = []
  for (const item of recent) {
    if (!item.title && !item.verdict) continue
    const title = item.title ?? null
    const verdict = item.verdict ?? null
    const previous = compressed.at(-1)
    if (previous && previous.title === title && previous.verdict === verdict) {
      previous.repeat_count += 1
      continue
    }
    compressed.push({ title, verdict, repeat_count: 1 })
  }
  return compressed
}

export function cleanExcerpt(text: string, limit: number): string {
  return Array.from(text.trim().split(/\s+/u).filter(Boolean).join(" "))
    .slice(0, limit)
    .join("")
}

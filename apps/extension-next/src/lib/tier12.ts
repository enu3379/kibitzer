// Tier 1 / Tier 2 judge wiring. Each tier routes to a provider+model pair from
// kibitzer:providers:v1 (Ollama Cloud stays the default — planning-notes D3); the
// per-provider key pool rotates on 401/403/429 exactly like the old Ollama-only path.
// Wire formats: Ollama native /api/chat, one OpenAI chat.completions adapter for the
// compat providers, and the Anthropic messages adapter.

import { ClaudeChatJudgeProvider } from "../providers/claudeChat.ts"
import { OllamaChatJudgeProvider } from "../providers/ollamaChat.ts"
import { OpenAIChatJudgeProvider } from "../providers/openaiChat.ts"
import {
  buildSessionSummaryPayload,
  buildTier1Payload,
  buildTier2MessagePayload,
  buildTier2ReviewPayload,
  type RecentTitle,
  type TopDriftHost,
} from "../providers/payloads.ts"
import { withRawResponseDebug } from "../providers/responseDebug.ts"
import type { JudgeProvider, JudgeVerdict } from "../providers/types.ts"
import { buildEnrichmentPrompt, ENRICH_TIMEOUT_MS, MAX_PHRASES, parseEnrichmentResponse } from "./goalEnrichment.ts"
import { klog } from "./klog.ts"
import {
  getJudgeSettings,
  profileFor,
  routeKeys,
  type JudgeSettings,
  type ProviderId,
  type TierName,
} from "./providers.ts"
import { recordUsage } from "./usage.ts"
import {
  activePersona,
  clampSentences,
  composeSummaryPrompt,
  composeWriterPrompt,
  DEFAULT_MAX_SENTENCES,
  pickFallback,
} from "./personas.ts"
import { detectSpecial, type SessionStats } from "./sessionStats.ts"
import type { SummaryDice } from "./summaryDice.ts"
import { classifyProviderError, recordProviderError, recordProviderOk } from "./providerHealth.ts"

/** History-derived context for the Tier-2 writer (built by gaugeRuntime from the nag /
 *  visit logs). `nagCount` is the 1-based ordinal of the nag about to be produced.
 *  `excerpt` is the current page's body text (null when it couldn't be extracted). */
export interface Tier2Context {
  nagCount: number
  naggingContext: Record<string, unknown>
  recentTitles: readonly RecentTitle[]
  excerpt: string | null
  timeContext: Record<string, unknown> | null
}

// These Cloud models reason before answering; a small budget exhausts before the
// JSON verdict (output_exhausted). Match the server's Judge budget.
const JUDGE_BUDGETS = { timeoutMs: 60_000, maxOutputTokens: 4096, writerMaxOutputTokens: 2048 } as const

function buildJudgeProvider(
  provider: ProviderId,
  model: string,
  keys: readonly string[],
): JudgeProvider {
  const profile = profileFor(provider)
  const onUsage = (tokensIn: number, tokensOut: number): void => {
    void recordUsage(provider, model, tokensIn, tokensOut)
  }
  if (profile.format === "ollama") {
    return new OllamaChatJudgeProvider({
      apiUrl: profile.chatUrl, model, apiKeys: keys, ...JUDGE_BUDGETS, onUsage,
    })
  }
  if (profile.format === "claude") {
    return new ClaudeChatJudgeProvider({
      chatUrl: profile.chatUrl, model, apiKeys: keys, ...JUDGE_BUDGETS, onUsage,
    })
  }
  return new OpenAIChatJudgeProvider({
    chatUrl: profile.chatUrl, model, apiKeys: keys, ...JUDGE_BUDGETS, ...(profile.wire ?? {}), onUsage,
  })
}

interface TierProviders {
  tier1: JudgeProvider | null // null = route has no keys → Tier-0 only for that tier
  tier2: JudgeProvider | null
}

let cache: TierProviders = { tier1: null, tier2: null }
let fingerprint: string | null = null

function makeTier(settings: JudgeSettings, tier: TierName): JudgeProvider | null {
  const keys = routeKeys(settings, tier)
  if (keys.length === 0) return null
  const route = settings.routes[tier]
  return buildJudgeProvider(route.provider, route.model, keys)
}

/** Per-tier judge providers for the saved routes. Settings changes are picked up on the
 *  next call via the fingerprint — no explicit cache invalidation needed. */
async function providers(): Promise<TierProviders> {
  const settings = await getJudgeSettings()
  const fp = JSON.stringify(settings)
  if (fingerprint !== fp) {
    cache = { tier1: makeTier(settings, "tier1"), tier2: makeTier(settings, "tier2") }
    fingerprint = fp
  }
  return cache
}

/** True when at least one tier can reach an LLM (drives the popup's on/off line and
 *  the pipeline's degraded-mode logging). */
export async function judgeEnabled(): Promise<boolean> {
  const p = await providers()
  return p.tier1 !== null || p.tier2 !== null
}

/** Let Tier 1 rescue a Tier-0 DRIFT (may return OK) or confirm it. Failure keeps DRIFT. */
export async function tier1Rescue(
  goalText: string,
  title: string,
  urlHost: string,
  recentTitles: readonly RecentTitle[] = [],
): Promise<JudgeVerdict> {
  const p = await providers()
  if (!p.tier1) return "DRIFT"
  try {
    const result = await p.tier1.classifyTier1(
      buildTier1Payload({ rawText: goalText }, { title, urlHost }, recentTitles),
    )
    void recordProviderOk()
    return result.verdict
  } catch (error) {
    void recordProviderError(error)
    klog(`tier1 error (keeping DRIFT): ${String(error)}`)
    return "DRIFT"
  }
}

export interface Tier2Outcome {
  flow: "drift" | "ok"
  message: string | null
  /** Set when the judge call itself failed (nag suppressed by fail-open) — lets the
   *  caller tell the user why judging went quiet. Not set for a mere writer failure
   *  (a fallback-template nag still fires) or when the route has no keys (deliberate
   *  Tier-0 mode, not an error). */
  providerError?: string
}

export interface RouteTestResult {
  ok: boolean
  detail: string
}

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; stage?: unknown; status?: unknown }
    const parts = [record.message, record.stage, record.status].filter((v) => v != null).map(String)
    if (parts.length) return parts.join(" · ")
  }
  return String(error)
}

function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** One real round-trip for one tier's route, using the provider's SAVED key pool and the
 *  given (possibly not-yet-saved) model. Reports success or a readable error, without
 *  saving — drives the options page's per-tier status chips. */
export async function testRoute(
  tier: TierName,
  provider: ProviderId,
  model: string,
): Promise<RouteTestResult> {
  const settings = await getJudgeSettings()
  const keys = (settings.accounts[provider]?.keys ?? []).map((k) => k.value)
  if (keys.length === 0) return { ok: false, detail: "키 없음 — 먼저 키를 추가하세요" }
  const trimmed = model.trim()
  if (!trimmed) return { ok: false, detail: "모델명이 비어 있어요" }
  const judge = buildJudgeProvider(provider, trimmed, keys)
  const startedAt = Date.now()
  try {
    if (tier === "tier1") {
      const r1 = await judge.classifyTier1(
        buildTier1Payload({ rawText: "테스트" }, { title: "예시 페이지", urlHost: "example.com" }, []),
      )
      return { ok: true, detail: `${trimmed} ✓ (${r1.verdict}) · ${elapsed(startedAt)}` }
    }
    await judge.confirmTier2(
      buildTier2ReviewPayload(
        { rawText: "테스트" },
        { title: "예시 페이지", urlHost: "example.com", verdict: "DRIFT", tierReached: 0, tier0Score: 0.3 },
        [],
        null,
        [],
        null,
      ),
    )
    return { ok: true, detail: `${trimmed} ✓ · ${elapsed(startedAt)}` }
  } catch (error) {
    return { ok: false, detail: errorText(error) }
  }
}

/** Expand the goal into cross-lingual search phrases via Tier 1 (retries the parse once,
 *  matching the server). Empty array if Ollama is off or the call fails. */
export async function enrichGoal(goalText: string): Promise<string[]> {
  const p = await providers()
  if (!p.tier1) return []
  const prompt = buildEnrichmentPrompt(goalText, MAX_PHRASES)
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const content = await p.tier1.completeGoalEnrichment(prompt, ENRICH_TIMEOUT_MS)
      return withRawResponseDebug(content, "goal enrichment", "content_json", () => (
        parseEnrichmentResponse(content, MAX_PHRASES)
      ))
    } catch (error) {
      lastError = error
    }
  }
  klog(`goal enrichment failed: ${String(lastError)}`)
  return []
}

/** Confirm a drift via Tier 2 — judge (notify/defer) then, if notify, the Writer in the
 *  selected persona's voice. No keys / judge failure → "ok" (false-positive-first). A
 *  Writer failure still nags, using the persona's offline fallback template.
 *
 *  `nagCount` is the 1-based ordinal of the nag about to be produced (drives the persona's
 *  "오늘 N번째" flavor and the fallback template index). */
export async function tier2Confirm(
  goalText: string,
  page: { title: string; urlHost: string; score: number },
  ctx: Tier2Context = { nagCount: 1, naggingContext: {}, recentTitles: [], excerpt: null, timeContext: null },
): Promise<Tier2Outcome> {
  const p = await providers()
  if (!p.tier2) return { flow: "ok", message: null }
  const observation = {
    title: page.title,
    urlHost: page.urlHost,
    verdict: "DRIFT" as const,
    // Reaching the Tier-2 gate means the page escalated past Tier-0 and (Tier-2 requires an
    // Ollama provider, so) Tier-1 ran — report tier_reached=1, not a hardcoded 0.
    tierReached: 1,
    tier0Score: page.score,
  }
  let decision
  try {
    const reviewPayload = buildTier2ReviewPayload(
      { rawText: goalText },
      observation,
      ctx.recentTitles,
      ctx.excerpt, // page body text → page_excerpt (content evidence for the judge)
      [],
      ctx.timeContext,
    )
    decision = await p.tier2.decideTier2(reviewPayload)
    void recordProviderOk()
  } catch (error) {
    void recordProviderError(error)
    klog(`tier2 judge error (fail-open to ok, no nag): ${String(error)}`)
    return { flow: "ok", message: null, providerError: classifyProviderError(error).message }
  }
  klog(`tier2 judge: ${decision.decision} (${decision.reasonCode}, basis=${decision.basis})`)
  if (decision.decision !== "notify") return { flow: "ok", message: null }
  // Notify confirmed → write the nag in the selected persona's voice.
  const persona = await activePersona()
  const maxSentences = persona.maxSentences ?? DEFAULT_MAX_SENTENCES
  const messagePayload = buildTier2MessagePayload(
    { rawText: goalText },
    observation,
    decision,
    ctx.timeContext,
    ctx.naggingContext,
  )
  try {
    const message = await p.tier2.writeTier2Message(messagePayload, composeWriterPrompt(persona))
    void recordProviderOk()
    return { flow: "drift", message: clampSentences(message, maxSentences) }
  } catch (error) {
    void recordProviderError(error)
    klog(`tier2 writer error (persona fallback template): ${String(error)}`)
    const message = pickFallback(persona, ctx.nagCount, {
      goal: goalText,
      title: page.title || page.urlHost || "현재 페이지",
      host: page.urlHost || "현재 페이지",
    })
    return { flow: "drift", message: message ? clampSentences(message, maxSentences) : message }
  }
}

// The recap is a retrospective, not a judge call: temperature is raised for this call only
// so repeated summaries vary in wording (the dice vary the framing). Judges stay at 0.
const SUMMARY_TEMPERATURE = 0.8
const SUMMARY_MAX_SENTENCES = 3

/** Persona-voiced end-of-session recap via the Tier-2 writer. Null when Ollama is off or
 *  the call fails — the caller shows a static fallback line (fail-open, like tier2Confirm). */
export async function writeSessionSummary(
  stats: SessionStats,
  dice: SummaryDice,
  topDriftHost: TopDriftHost | null = null,
): Promise<string | null> {
  const p = await providers()
  if (!p.tier2) return null
  try {
    const persona = await activePersona()
    const payload = buildSessionSummaryPayload(
      {
        goalText: stats.goalText,
        // "session minutes" for the recap = active browsing time, not wall-clock (a goal left
        // open overnight must not read as an all-nighter).
        sessionMinutes: Math.round(stats.activeMs / 60_000),
        pagesTotal: stats.pagesTotal,
        pagesOk: stats.pagesOk,
        okRatio: stats.okRatio,
        validMinutes: Math.round(stats.validMs / 60_000),
        nagCount: stats.nagCount,
        topPages: stats.topPages.map((page) => ({
          title: page.title,
          host: page.host,
          minutes: Math.round(page.ms / 60_000),
          verdict: page.verdict,
        })),
      },
      dice,
      detectSpecial(stats),
      topDriftHost,
    )
    const message = await p.tier2.writeTier2Message(payload, composeSummaryPrompt(persona), {
      temperature: SUMMARY_TEMPERATURE,
    })
    void recordProviderOk()
    return clampSentences(message, dice.bonus ? SUMMARY_MAX_SENTENCES + 1 : SUMMARY_MAX_SENTENCES)
  } catch (error) {
    void recordProviderError(error)
    klog(`session summary writer error (static fallback): ${String(error)}`)
    return null
  }
}

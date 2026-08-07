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
import { getSettings } from "./settings.ts"

/** History-derived context for the Tier-2 writer (built by gaugeRuntime from the nag /
 *  visit logs). `nagCount` is the 1-based ordinal of the nag about to be produced.
 *  `excerpt` is the current page's body text (null when it couldn't be extracted). */
export interface Tier2Context {
  nagCount: number
  naggingContext: Record<string, unknown>
  recentTitles: readonly RecentTitle[]
  excerpt: string | null
  timeContext: Record<string, unknown> | null
  // Pay for the second (message-writing) call once the judge says notify? The gauge decides —
  // see GaugeEffect.request_tier2.useWriter. False returns the drift verdict with no message,
  // which the nag delivery already knows how to render from the persona preset (the same path
  // a Writer failure lands on). Defaults to true so an omitted context behaves as before.
  useWriter?: boolean
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
  const [settings, appSettings] = await Promise.all([getJudgeSettings(), getSettings()])
  const fp = JSON.stringify([settings, appSettings.aiJudgmentEnabled])
  if (fingerprint !== fp) {
    const tier1 = makeTier(settings, "tier1")
    const tier2 = makeTier(settings, "tier2")
    // AI judging is one complete product mode: explicit OFF, or either missing tier,
    // disables every LLM call (rescue, confirm, message writing, enrichment, recap).
    // Route tests bypass this helper so users can repair an incomplete setup.
    cache = appSettings.aiJudgmentEnabled && tier1 && tier2 ? { tier1, tier2 } : { tier1: null, tier2: null }
    fingerprint = fp
  }
  return cache
}

/** True only for an explicitly enabled, complete two-tier AI setup. */
export async function judgeEnabled(): Promise<boolean> {
  const p = await providers()
  return p.tier1 !== null && p.tier2 !== null
}

export interface Tier1RescueResult {
  verdict: JudgeVerdict
  /** False when Tier 1 produced no judgment — the route has no keys, or the call failed.
   *  The DRIFT is then Tier 0's verdict standing unrescued, and the caller must not record
   *  tierReached=1 for a tier that never answered. */
  answered: boolean
}

/** Let Tier 1 rescue a Tier-0 DRIFT (may return OK) or confirm it. Failure keeps DRIFT. */
export async function tier1Rescue(
  goalText: string,
  title: string,
  urlHost: string,
  recentTitles: readonly RecentTitle[] = [],
): Promise<Tier1RescueResult> {
  const p = await providers()
  if (!p.tier1) return { verdict: "DRIFT", answered: false }
  try {
    const result = await p.tier1.classifyTier1(
      buildTier1Payload({ rawText: goalText }, { title, urlHost }, recentTitles),
    )
    void recordProviderOk("tier1")
    return { verdict: result.verdict, answered: true }
  } catch (error) {
    void recordProviderError("tier1", error)
    klog(`tier1 error (keeping DRIFT): ${String(error)}`)
    return { verdict: "DRIFT", answered: false }
  }
}

export interface Tier2Outcome {
  flow: "drift" | "ok"
  message: string | null
  /** Policy changed before a not-yet-started provider boundary; caller cancels the job. */
  cancelled?: boolean
  /** No judgment was obtained — the tier has no route configured, or the judge call failed.
   *  Distinct from `flow: "ok"`, which is a real verdict ("this page does not warrant a nudge").
   *  Both used to arrive as a bare "ok", so the caller applied the OK branch and rewarded a page
   *  nobody had actually judged. Callers must treat this as "unknown", never as a verdict. */
  unavailable?: boolean
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

export interface CandidateKeyTestResult {
  ok: boolean
  tiers: Record<TierName, RouteTestResult>
}

/** Treat a failed policy/state read as cancellation at provider boundaries. */
export async function safeShouldContinue(
  shouldContinue: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await shouldContinue()
  } catch {
    return false
  }
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

async function testRouteWithKeys(
  tier: TierName,
  provider: ProviderId,
  model: string,
  keys: readonly string[],
): Promise<RouteTestResult> {
  if (keys.length === 0) return { ok: false, detail: "키 없음 — 먼저 키를 추가하세요" }
  const trimmed = model.trim()
  if (!trimmed) return { ok: false, detail: "모델명이 비어 있어요" }
  const startedAt = Date.now()
  try {
    const judge = buildJudgeProvider(provider, trimmed, keys)
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
  return await testRouteWithKeys(tier, provider, model, keys)
}

/** Validate an unsaved candidate key against both tier models. The key is deliberately
 *  passed as a one-item pool, so an existing saved key can never rotate in and create a
 *  false success. Setup failures are returned inline only: no provider-health record is
 *  written and the candidate key never touches storage here. */
export async function testCandidateKey(
  provider: ProviderId,
  value: string,
  models: Record<TierName, string>,
): Promise<CandidateKeyTestResult> {
  const key = value.trim()
  if (!key) {
    const missing = { ok: false, detail: "API 키를 입력해 주세요" }
    return { ok: false, tiers: { tier1: missing, tier2: missing } }
  }
  const tier1 = await testRouteWithKeys("tier1", provider, models.tier1, [key])
  const tier2 = await testRouteWithKeys("tier2", provider, models.tier2, [key])
  return { ok: tier1.ok && tier2.ok, tiers: { tier1, tier2 } }
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
  // Deliberately records NO provider health — neither ok nor error. Goal expansion is an
  // internal pipeline stage the user doesn't know exists, so surfacing its failure as
  // "빠른 판정 오류" has no actionable value; a genuinely broken tier1 route is surfaced
  // honestly by the next rescue call (which fires on every drifting page) within minutes.
  // Recording ok would be worse than silence: an enrichment success clearing a genuine
  // rescue error (they parse different response shapes) would be a false all-clear.
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
  page: { title: string; urlHost: string; score: number; kind?: "web" | "local_pdf"; tierReached?: number },
  ctx: Tier2Context = { nagCount: 1, naggingContext: {}, recentTitles: [], excerpt: null, timeContext: null },
  shouldContinue: () => Promise<boolean> = async () => true,
): Promise<Tier2Outcome> {
  const p = await providers()
  // No Tier-2 route (or its provider has no key): nothing was asked, so there is no verdict.
  if (!p.tier2) return { flow: "ok", message: null, unavailable: true }
  const observation = {
    title: page.title,
    urlHost: page.urlHost,
    verdict: "DRIFT" as const,
    // The tiers route independently, so a reachable Tier 2 proves nothing about Tier 1: in a
    // Tier-2-only setup this gate is reached with Tier 1 never asked. tier_reached must come
    // from the observe-time record; when the record has none (pre-field checkpoints, direct
    // callers), 0 is the value that claims nothing.
    tierReached: page.tierReached ?? 0,
    tier0Score: page.score,
  }
  let decision
  try {
    if (!(await safeShouldContinue(shouldContinue))) return { flow: "ok", message: null, cancelled: true }
    const reviewPayload = buildTier2ReviewPayload(
      { rawText: goalText },
      observation,
      ctx.recentTitles,
      ctx.excerpt, // page body text → page_excerpt (content evidence for the judge)
      [],
      ctx.timeContext,
    )
    decision = await p.tier2.decideTier2(reviewPayload)
    void recordProviderOk("tier2")
  } catch (error) {
    void recordProviderError("tier2", error, "judge")
    klog(`tier2 judge error (no verdict, request released): ${String(error)}`)
    return {
      flow: "ok",
      message: null,
      unavailable: true, // the judge was asked and did not answer — still not a verdict
      providerError: classifyProviderError(error).message,
    }
  }
  klog(`tier2 judge: ${decision.decision} (${decision.reasonCode}, basis=${decision.basis})`)
  if (decision.decision !== "notify") return { flow: "ok", message: null }
  if (!(await safeShouldContinue(shouldContinue))) return { flow: "ok", message: null, cancelled: true }
  // Notify confirmed, but this request may not write its own message (a promotion, or a repeat
  // s_zero confirmation while the user page-hops at S=0). Return the verdict alone — delivery
  // falls back to the persona preset — and skip the second round trip entirely.
  if (ctx.useWriter === false) return { flow: "drift", message: null }
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
    if (!(await safeShouldContinue(shouldContinue))) return { flow: "ok", message: null, cancelled: true }
    const message = await p.tier2.writeTier2Message(messagePayload, composeWriterPrompt(persona))
    void recordProviderOk("tier2")
    return { flow: "drift", message: clampSentences(message, maxSentences) }
  } catch (error) {
    void recordProviderError("tier2", error, "writer")
    klog(`tier2 writer error (persona fallback template): ${String(error)}`)
    const fallbackTitle = page.title || page.urlHost || "현재 페이지"
    const message = pickFallback(persona, ctx.nagCount, {
      goal: goalText,
      title: fallbackTitle,
      host: page.kind === "local_pdf" ? fallbackTitle : (page.urlHost || "현재 페이지"),
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
    void recordProviderOk("tier2")
    return clampSentences(message, dice.bonus ? SUMMARY_MAX_SENTENCES + 1 : SUMMARY_MAX_SENTENCES)
  } catch (error) {
    // The recap writer shares the Writer's health bucket — one "writer" stage in the UI.
    void recordProviderError("tier2", error, "writer")
    klog(`session summary writer error (static fallback): ${String(error)}`)
    return null
  }
}

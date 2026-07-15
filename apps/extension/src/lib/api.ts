import { serverFetch } from "./serverConnection.ts"

export interface BrowserNavPayload {
  url: string
  title: string
  tab_id?: number
}

export interface PipelineResult {
  action: "none" | "request_excerpt" | "notify"
  kind?: "intervention" | "celebration"
  observation_id?: string | null
  candidate_id?: string | null
  verdict?: "OK" | "DRIFT" | null
  message?: string | null
  intervention_id?: string | null
  page?: PageInfo | null
  silent?: boolean
}

export interface PageInfo {
  host?: string | null
  title?: string | null
}

export interface PageExcerpt {
  title: string
  text: string
}

export type PresenceKind = "active" | "heartbeat" | "inactive"

export interface ContentCaptureResult {
  observation_id: string
  stored: boolean
  char_count: number
}

export type FeedbackKind = "related" | "accepted" | "snooze" | "break"

export interface FeedbackPayload {
  kind: FeedbackKind
  intervention_id: string
  observation_id?: string | null
}

export interface FeedbackResult {
  feedback_id: string
  kind: FeedbackKind
  duplicate: boolean
  intervention_id: string
  observation_id?: string | null
  intervention_status: string
  verdict?: "OK" | "DRIFT" | null
  exemplar_count?: number | null
  snoozed_until?: string | null
}

export type PageLabel = "related" | "drift"

export interface LatestObservationFeatures {
  r0?: number | null
  r_override?: number | null
  exemplar_score?: number | null
  derived_score?: number | null
  anchor_eligible?: boolean | null
  tier_reached?: number | null
}

export interface LatestObservation {
  observation_id: string
  title?: string | null
  url_host?: string | null
  verdict?: "OK" | "DRIFT" | null
  features: LatestObservationFeatures
  tier1_reason?: string | null
  tau_ok?: number | null
  label?: PageLabel | null
}

export type CurrentPageProcessingStage = "tier0" | "tier1"

export interface CurrentPageState {
  state: "unobserved" | "processing" | "judged"
  stage?: CurrentPageProcessingStage | null
  observation_id?: string | null
  title?: string | null
  url_host?: string | null
  observation?: LatestObservation | null
}

export interface PageLabelResult {
  label_id: string
  observation_id: string
  label: PageLabel
  verdict: "OK" | "DRIFT" | null
  exemplar_count?: number | null
}

export interface PendingIntervention {
  intervention_id: string
  observation_id?: string | null
  message: string
  ts: string
  status: string
  tier1_reason?: string | null
}

export interface SessionState {
  session_id: string
  has_goal: boolean
  tracking: "coldstart" | "tracking" | "snoozed" | "cooldown"
  controller_type: ControllerType
  streak: number
  streak_threshold: number
  alignment_score?: number | null
  theta_low?: number | null
  theta_high?: number | null
  obs_count: number
  coldstart_observations: number
  snoozed_until?: string | null
  cooldown_until?: string | null
  pending_intervention?: PendingIntervention | null
  time_budget?: TimeBudgetState | null
}

export interface TimeBudgetState {
  available_time_minutes?: number | null
  total_seconds: number
  per_page_seconds: number
  current_page_drift_seconds: number
  mode_clock_seconds: number
  next_review_mode_seconds: number
  status: string
  last_defer_reason?: string | null
}

export type SessionStateResult =
  | { kind: "state"; state: SessionState }
  | { kind: "no_session" }
  | { kind: "unreachable" }

export interface SessionInfo {
  id: string
  created_at: string
  active: boolean
}

export interface GoalInfo {
  session_id: string
  raw_text: string
  provenance: string
  updated_at: string
  available_time_minutes?: number | null
}

export interface CurrentSession {
  session: SessionInfo
  goal?: GoalInfo | null
}

export interface PersonaSummary {
  key: string
  name: string
}

export interface SessionStats {
  session_id: string
  started_at: string
  ended_at?: string | null
  duration_seconds: number
  observations: number
  ok: number
  drift: number
  unjudged: number
  related_ratio?: number | null
  interventions: number
  interventions_accepted: number
  top_drift_host?: string | null
  top_drift_count: number
}

export interface SnoozeResult {
  session_id: string
  snoozed_until: string
}

export async function deleteAllActivityData(): Promise<boolean> {
  const response = await serverFetch("/data/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE" }),
  })
  if (!response?.ok) return false
  try {
    const body = (await response.json()) as { deleted?: unknown }
    return body.deleted === true
  } catch {
    return false
  }
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const response = await serverFetch("/sessions/current")
  if (!response?.ok) return null
  return response.json() as Promise<CurrentSession>
}

export async function createSession(): Promise<SessionInfo | null> {
  const response = await serverFetch("/sessions", { method: "POST" })
  if (!response?.ok) return null
  return response.json() as Promise<SessionInfo>
}

export async function setGoal(rawText: string, availableTimeMinutes?: number | null): Promise<GoalInfo | null> {
  const response = await serverFetch("/sessions/current/goal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw_text: rawText, available_time_minutes: availableTimeMinutes ?? null }),
  })
  if (!response?.ok) return null
  return response.json() as Promise<GoalInfo>
}

export async function getSessionStats(): Promise<SessionStats | null> {
  const response = await serverFetch("/sessions/current/stats")
  if (!response?.ok) return null
  return response.json() as Promise<SessionStats>
}

export async function getPersonas(): Promise<PersonaSummary[]> {
  const response = await serverFetch("/personas")
  if (!response?.ok) return []
  return response.json() as Promise<PersonaSummary[]>
}

export async function postSessionSnooze(durationSeconds?: number): Promise<SnoozeResult | null> {
  const body = durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }
  const response = await serverFetch("/sessions/current/snooze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response?.ok) return null
  return response.json() as Promise<SnoozeResult>
}

export async function postDeliveryReport(
  interventionId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  await serverFetch(`/interventions/${interventionId}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok, error: error ?? null }),
  })
}

export async function postSessionEnd(): Promise<SessionStats | null> {
  const response = await serverFetch("/sessions/current/end", { method: "POST" })
  if (!response?.ok) return null
  return response.json() as Promise<SessionStats>
}

export interface QuietHours {
  enabled: boolean
  start: string
  end: string
}

export interface Cooldown {
  enabled: boolean
  seconds: number
}

export interface DwellSettings {
  observation_seconds: number
  tier2_seconds: number
}

export interface RelevanceSettings {
  tau_ok: number
}

export type ControllerType = "streak" | "alignment"

export interface ControllerSettings {
  type: ControllerType
  k: number
  alignment_alpha: number
  theta_low: number
  theta_high: number
}

export interface Settings {
  persona: string
  voice_enabled: boolean
  relevance: RelevanceSettings
  controller: ControllerSettings
  cooldown: Cooldown
  dwell: DwellSettings
  quiet_hours: QuietHours
}

export interface SettingsPatch {
  persona?: string
  voice_enabled?: boolean
  relevance?: Partial<RelevanceSettings>
  controller?: Partial<ControllerSettings>
  cooldown?: Partial<Cooldown>
  dwell?: Partial<DwellSettings>
  quiet_hours?: Partial<QuietHours>
}

export type SettingsUpdateResult =
  | { kind: "updated"; settings: Settings }
  | { kind: "unreachable" }
  | { kind: "http_error"; status: number; detail: string | null }

export function normalizeSettings(value: Partial<Settings>): Settings {
  const rawRelevance = (value.relevance ?? {}) as Partial<RelevanceSettings>
  const rawController = (value.controller ?? {}) as Partial<ControllerSettings>
  const rawCooldown = (value.cooldown ?? {}) as Partial<Cooldown>
  const rawDwell = (value.dwell ?? {}) as Partial<DwellSettings>
  const rawQuietHours = (value.quiet_hours ?? {}) as Partial<QuietHours>
  const rawType = String(rawController.type ?? "")
  const controllerType: ControllerType = rawType === "alignment" || rawType === "window" ? "alignment" : "streak"
  const k = clampInt(rawController.k, 3, 1, 20)
  const alignmentAlpha = clampFloat(rawController.alignment_alpha, 0.85, 0, 0.99)
  const thetaLow = clampFloat(rawController.theta_low, 0.15, 0, 0.99)
  const thetaHigh = Math.max(thetaLow + 0.01, clampFloat(rawController.theta_high, 0.3, 0, 1))

  return {
    persona: typeof value.persona === "string" ? value.persona : "dry_kibitzer",
    voice_enabled: Boolean(value.voice_enabled),
    relevance: {
      tau_ok: clampFloat(rawRelevance.tau_ok, 0.15, 0, 1),
    },
    controller: {
      type: controllerType,
      k,
      alignment_alpha: alignmentAlpha,
      theta_low: thetaLow,
      theta_high: Math.min(1, thetaHigh),
    },
    cooldown: {
      enabled: Boolean(rawCooldown.enabled),
      seconds: clampInt(rawCooldown.seconds, 0, 0, 86400),
    },
    dwell: {
      observation_seconds: clampInt(rawDwell.observation_seconds, 5, 1, 300),
      tier2_seconds: clampInt(rawDwell.tier2_seconds, 10, 1, 300),
    },
    quiet_hours: {
      enabled: Boolean(rawQuietHours.enabled),
      start: typeof rawQuietHours.start === "string" ? rawQuietHours.start : "09:00",
      end: typeof rawQuietHours.end === "string" ? rawQuietHours.end : "18:00",
    },
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

export async function getSettings(): Promise<Settings | null> {
  const response = await serverFetch("/settings")
  if (!response?.ok) return null
  const body = (await response.json()) as Partial<Settings>
  return normalizeSettings(body)
}

export async function putSettings(patch: SettingsPatch): Promise<SettingsUpdateResult> {
  const response = await serverFetch("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  if (!response) return { kind: "unreachable" }
  if (!response.ok) {
    return {
      kind: "http_error",
      status: response.status,
      detail: await readHttpErrorDetail(response),
    }
  }
  const body = (await response.json()) as Partial<Settings>
  return { kind: "updated", settings: normalizeSettings(body) }
}

async function readHttpErrorDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === "string") return body.detail
    if (!Array.isArray(body.detail)) return null
    const issue = body.detail.find(
      (item): item is { msg: string } =>
        Boolean(item) && typeof item === "object" && typeof (item as { msg?: unknown }).msg === "string",
    )
    return issue?.msg ?? null
  } catch {
    return null
  }
}

export async function getSessionState(): Promise<SessionStateResult> {
  const response = await serverFetch("/sessions/current/state")
  if (!response) return { kind: "unreachable" }
  if (response.status === 404) return { kind: "no_session" }
  if (!response.ok) return { kind: "unreachable" }
  const state = (await response.json()) as SessionState
  return { kind: "state", state }
}

export async function postBrowserNav(
  payload: BrowserNavPayload,
  idempotencyKey: string,
): Promise<PipelineResult | null> {
  const response = await serverFetch("/observations/browser-nav", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "browser_nav", payload, idempotency_key: idempotencyKey }),
  })
  if (!response?.ok) return null
  return response.json() as Promise<PipelineResult>
}

export async function postFeedback(payload: FeedbackPayload): Promise<FeedbackResult | null> {
  const response = await serverFetch("/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response?.ok) return null
  return response.json() as Promise<FeedbackResult>
}

export async function getLatestObservation(tabId: number, url: string): Promise<LatestObservation | null> {
  try {
    const parsed = new URL(url)
    const urlPathHash = await urlPathHashFor(url)
    const params = new URLSearchParams({
      tab_id: String(tabId),
      url_host: parsed.hostname,
      url_path_hash: urlPathHash,
    })
    const response = await serverFetch(`/observations/latest?${params}`)
    if (!response?.ok) return null
    return response.json() as Promise<LatestObservation>
  } catch {
    return null
  }
}

export async function getCurrentPageState(tabId: number, url: string): Promise<CurrentPageState | null> {
  try {
    const parsed = new URL(url)
    const urlPathHash = await urlPathHashFor(url)
    const params = new URLSearchParams({
      tab_id: String(tabId),
      url_host: parsed.hostname,
      url_path_hash: urlPathHash,
    })
    const response = await serverFetch(`/observations/page-state?${params}`)
    if (!response?.ok) return null
    return response.json() as Promise<CurrentPageState>
  } catch {
    return null
  }
}

export async function urlPathHashFor(url: string): Promise<string> {
  const parsed = new URL(url)
  const location = `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`
  const pathBytes = new TextEncoder().encode(location)
  const pathDigest = await crypto.subtle.digest("SHA-256", pathBytes)
  return Array.from(new Uint8Array(pathDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function postObservationLabel(
  observationId: string,
  label: PageLabel,
): Promise<PageLabelResult | null> {
  const response = await serverFetch(`/observations/${observationId}/label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  })
  if (!response?.ok) return null
  return response.json() as Promise<PageLabelResult>
}

export async function postObservationExcerpt(
  observationId: string,
  excerpt: PageExcerpt,
): Promise<PipelineResult | null> {
  const response = await serverFetch(`/observations/${observationId}/excerpt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(excerpt),
  })
  if (!response?.ok) return null
  return response.json() as Promise<PipelineResult>
}

export async function postObservationContent(
  observationId: string,
  excerpt: PageExcerpt,
): Promise<ContentCaptureResult | null> {
  const response = await serverFetch(`/observations/${observationId}/content`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(excerpt),
  })
  if (!response?.ok) return null
  return response.json() as Promise<ContentCaptureResult>
}

export async function postObservationPresence(
  observationId: string,
  payload: { event_id: string; kind: PresenceKind; tab_id: number; url_path_hash: string },
): Promise<PipelineResult | null> {
  const response = await serverFetch(`/observations/${observationId}/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response?.ok) return null
  return response.json() as Promise<PipelineResult>
}

export interface HealthTiers {
  tier1?: string
  tier2?: string
}

export type ProviderCallResult = "none" | "success" | "error"
export type ProviderFailureReason =
  | "timeout"
  | "connection"
  | "auth"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "invalid_response"
  | "other"

export interface ProviderCallStatus {
  last_result: ProviderCallResult
  reason?: ProviderFailureReason | null
  checked_at?: string | null
}

export interface ProviderCalls {
  tier1?: ProviderCallStatus
  tier2?: ProviderCallStatus
}

export interface HealthStatus {
  tiers: HealthTiers
  provider_calls: ProviderCalls
}

export async function getHealthStatus(): Promise<HealthStatus | null> {
  const response = await serverFetch("/health")
  if (!response?.ok) return null
  const body = (await response.json()) as Partial<HealthStatus>
  return {
    tiers: body.tiers ?? {},
    provider_calls: body.provider_calls ?? {},
  }
}

export interface ReportHourBucket {
  hour: string
  observations: number
  ok: number
  drift: number
  related_ratio?: number | null
}

export interface ReportDriftHost {
  host: string
  count: number
}

export interface ReportOkStretch {
  start: string
  end: string
  minutes: number
}

export interface ReportJudgment {
  observation_id: string
  ts: string
  verdict?: string | null
  url_host?: string | null
  title?: string | null
  tier_reached?: number | null
  tier1_reason?: string | null
}

export interface SessionReport {
  scope: string
  session_id?: string | null
  date?: string | null
  started_at?: string | null
  ended_at?: string | null
  duration_seconds: number
  observations: number
  ok: number
  drift: number
  unjudged: number
  related_ratio?: number | null
  hourly_related_ratio: ReportHourBucket[]
  top_drift_hosts: ReportDriftHost[]
  longest_ok_stretch?: ReportOkStretch | null
  intervention_status_counts: Record<string, number>
  feedback_counts: Record<string, number>
  judgments: ReportJudgment[]
}

export async function getSessionReport(): Promise<SessionReport | null> {
  const response = await serverFetch("/sessions/current/report")
  if (!response?.ok) return null
  return response.json() as Promise<SessionReport>
}

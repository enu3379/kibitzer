const SERVER_BASE_URL = "http://127.0.0.1:8765"

export interface BrowserNavPayload {
  url: string
  title: string
  tab_id?: number
}

export interface PipelineResult {
  action: "none" | "request_excerpt" | "notify"
  kind?: "intervention" | "celebration"
  observation_id?: string | null
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
  exemplar_count?: number | null
  snoozed_until?: string | null
}

export type PageLabel = "related" | "drift"

export interface LatestObservationFeatures {
  r0?: number | null
  exemplar_score?: number | null
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

export interface PageLabelResult {
  label_id: string
  observation_id: string
  label: PageLabel
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
  keywords: string[]
  provenance: string
  updated_at: string
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

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current`).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<CurrentSession>
}

export async function createSession(): Promise<SessionInfo | null> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions`, { method: "POST" }).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<SessionInfo>
}

export async function setGoal(rawText: string): Promise<GoalInfo | null> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/goal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw_text: rawText }),
  }).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<GoalInfo>
}

export async function getSessionStats(): Promise<SessionStats | null> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/stats`).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<SessionStats>
}

export async function getPersonas(): Promise<PersonaSummary[]> {
  const response = await fetch(`${SERVER_BASE_URL}/personas`).catch(() => null)
  if (!response?.ok) return []
  return response.json() as Promise<PersonaSummary[]>
}

export async function postSessionSnooze(durationSeconds?: number): Promise<SnoozeResult | null> {
  const body = durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/snooze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<SnoozeResult>
}

export async function postDeliveryReport(
  interventionId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  await fetch(`${SERVER_BASE_URL}/interventions/${interventionId}/delivery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok, error: error ?? null }),
  }).catch(() => null)
}

export async function postSessionEnd(): Promise<SessionStats | null> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/end`, { method: "POST" }).catch(() => null)
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

function normalizeSettings(value: Partial<Settings>): Settings {
  const rawRelevance = (value.relevance ?? {}) as Partial<RelevanceSettings>
  const rawController = (value.controller ?? {}) as Partial<ControllerSettings>
  const rawCooldown = (value.cooldown ?? {}) as Partial<Cooldown>
  const rawDwell = (value.dwell ?? {}) as Partial<DwellSettings>
  const rawQuietHours = (value.quiet_hours ?? {}) as Partial<QuietHours>
  const rawType = String(rawController.type ?? "")
  const controllerType: ControllerType = rawType === "alignment" || rawType === "window" ? "alignment" : "streak"
  const k = clampInt(rawController.k, 3, 1, 20)
  const alignmentAlpha = clampFloat(rawController.alignment_alpha, 0.85, 0, 0.99)
  const thetaLow = clampFloat(rawController.theta_low, 0.15, 0, 1)
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
  const response = await fetch(`${SERVER_BASE_URL}/settings`).catch(() => null)
  if (!response?.ok) return null
  const body = (await response.json()) as Partial<Settings>
  return normalizeSettings(body)
}

export async function putSettings(patch: SettingsPatch): Promise<Settings | null> {
  const response = await fetch(`${SERVER_BASE_URL}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => null)
  if (!response?.ok) return null
  const body = (await response.json()) as Partial<Settings>
  return normalizeSettings(body)
}

export async function getSessionState(): Promise<SessionStateResult> {
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/state`).catch(() => null)
  if (!response) return { kind: "unreachable" }
  if (response.status === 404) return { kind: "no_session" }
  if (!response.ok) return { kind: "unreachable" }
  const state = (await response.json()) as SessionState
  return { kind: "state", state }
}

export async function postBrowserNav(payload: BrowserNavPayload): Promise<PipelineResult | null> {
  const response = await fetch(`${SERVER_BASE_URL}/observations/browser-nav`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "browser_nav", payload }),
  }).catch(() => {
    // The extension must never interrupt browsing because the local server is down.
    return null
  })
  if (!response?.ok) return null
  return response.json() as Promise<PipelineResult>
}

export async function postFeedback(payload: FeedbackPayload): Promise<FeedbackResult | null> {
  const response = await fetch(`${SERVER_BASE_URL}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    return null
  })
  if (!response?.ok) return null
  return response.json() as Promise<FeedbackResult>
}

export async function getLatestObservation(tabId: number, url: string): Promise<LatestObservation | null> {
  try {
    const parsed = new URL(url)
    const location = `${parsed.pathname || "/"}${parsed.search}${parsed.hash}`
    const pathBytes = new TextEncoder().encode(location)
    const pathDigest = await crypto.subtle.digest("SHA-256", pathBytes)
    const urlPathHash = Array.from(new Uint8Array(pathDigest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
    const params = new URLSearchParams({
      tab_id: String(tabId),
      url_host: parsed.hostname,
      url_path_hash: urlPathHash,
    })
    const response = await fetch(`${SERVER_BASE_URL}/observations/latest?${params}`)
    if (!response.ok) return null
    return response.json() as Promise<LatestObservation>
  } catch {
    return null
  }
}

export async function postObservationLabel(
  observationId: string,
  label: PageLabel,
): Promise<PageLabelResult | null> {
  const response = await fetch(`${SERVER_BASE_URL}/observations/${observationId}/label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  }).catch(() => {
    return null
  })
  if (!response?.ok) return null
  return response.json() as Promise<PageLabelResult>
}

export async function postObservationExcerpt(
  observationId: string,
  excerpt: PageExcerpt,
): Promise<PipelineResult | null> {
  const response = await fetch(`${SERVER_BASE_URL}/observations/${observationId}/excerpt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(excerpt),
  }).catch(() => {
    return null
  })
  if (!response?.ok) return null
  return response.json() as Promise<PipelineResult>
}

export interface HealthTiers {
  tier1?: string
  tier2?: string
}

export async function getHealthTiers(): Promise<HealthTiers | null> {
  const response = await fetch(`${SERVER_BASE_URL}/health`).catch(() => null)
  if (!response?.ok) return null
  const body = (await response.json()) as { tiers?: HealthTiers }
  return body.tiers ?? null
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
  const response = await fetch(`${SERVER_BASE_URL}/sessions/current/report`).catch(() => null)
  if (!response?.ok) return null
  return response.json() as Promise<SessionReport>
}

const SERVER_BASE_URL = "http://127.0.0.1:8765"

export interface BrowserNavPayload {
  url: string
  title: string
  tab_id?: number
}

export interface PipelineResult {
  action: "none" | "request_excerpt" | "notify"
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

export type FeedbackKind = "related" | "accepted" | "snooze"

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

export interface PendingIntervention {
  intervention_id: string
  observation_id?: string | null
  message: string
  ts: string
  status: string
}

export interface SessionState {
  session_id: string
  has_goal: boolean
  tracking: "coldstart" | "tracking" | "snoozed" | "cooldown"
  controller_type: ControllerType
  streak: number
  streak_threshold: number
  window_size: number
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

export type ControllerType = "streak" | "window"

export interface ControllerSettings {
  type: ControllerType
  k: number
  window_size: number
}

export interface Settings {
  persona: string
  voice_enabled: boolean
  controller: ControllerSettings
  cooldown: Cooldown
  quiet_hours: QuietHours
}

export interface SettingsPatch {
  persona?: string
  voice_enabled?: boolean
  controller?: Partial<ControllerSettings>
  cooldown?: Partial<Cooldown>
  quiet_hours?: Partial<QuietHours>
}

function normalizeSettings(value: Partial<Settings>): Settings {
  const rawController = (value.controller ?? {}) as Partial<ControllerSettings>
  const rawCooldown = (value.cooldown ?? {}) as Partial<Cooldown>
  const rawQuietHours = (value.quiet_hours ?? {}) as Partial<QuietHours>
  const controllerType: ControllerType = rawController.type === "window" ? "window" : "streak"
  const k = clampInt(rawController.k, 3, 1, 20)
  const windowSize = clampInt(rawController.window_size, Math.max(5, k), controllerType === "window" ? k : 1, 50)

  return {
    persona: typeof value.persona === "string" ? value.persona : "dry_kibitzer",
    voice_enabled: Boolean(value.voice_enabled),
    controller: {
      type: controllerType,
      k,
      window_size: windowSize,
    },
    cooldown: {
      enabled: Boolean(rawCooldown.enabled),
      seconds: clampInt(rawCooldown.seconds, 0, 0, 86400),
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

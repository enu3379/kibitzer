// User-tunable settings (options page). Stored in chrome.storage.local so they survive
// restarts. Kept separate from the Ollama config (tier12) and persona (personas).

const SETTINGS_KEY = "kibitzer:settings:v1"

export interface QuietHours {
  enabled: boolean
  start: string // "HH:MM"
  end: string // "HH:MM"
}

export interface Settings {
  tauOk: number // Tier-0 OK threshold (sensitivity); lower = stricter (more drift)
  quietHours: QuietHours
  ttsEnabled: boolean // speak the nag via Web Speech
}

export const DEFAULT_SETTINGS: Settings = {
  tauOk: 0.59, // O4-recalibrated default (matches tier0.TAU_OK)
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  ttsEnabled: false,
}

function coerce(value: Partial<Settings> | undefined): Settings {
  const q = value?.quietHours
  return {
    tauOk: typeof value?.tauOk === "number" ? clamp(value.tauOk, 0, 1) : DEFAULT_SETTINGS.tauOk,
    quietHours: {
      enabled: Boolean(q?.enabled),
      start: typeof q?.start === "string" ? q.start : DEFAULT_SETTINGS.quietHours.start,
      end: typeof q?.end === "string" ? q.end : DEFAULT_SETTINGS.quietHours.end,
    },
    ttsEnabled: Boolean(value?.ttsEnabled),
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  return coerce(stored[SETTINGS_KEY] as Partial<Settings> | undefined)
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings()
  const merged = coerce({ ...current, ...patch, quietHours: { ...current.quietHours, ...patch.quietHours } })
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged })
  return merged
}

/** True if `now` falls within the quiet-hours window (handles windows crossing midnight). */
export function inQuietHours(q: QuietHours, now: number): boolean {
  if (!q.enabled) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = toMinutes(q.start)
  const end = toMinutes(q.end)
  if (start === end) return false
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10))
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

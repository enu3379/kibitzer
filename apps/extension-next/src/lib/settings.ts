// User-tunable settings (options page). Stored in chrome.storage.local so they survive
// restarts. Kept separate from the Ollama config (tier12) and persona (personas).

const SETTINGS_KEY = "kibitzer:settings:v1"

export interface QuietHours {
  enabled: boolean
  start: string // "HH:MM"
  end: string // "HH:MM"
}

export interface Settings {
  tauOk: number // Tier-0 OK threshold; one of SENSITIVITY_PRESETS (higher = stricter, more drift)
  quietHours: QuietHours
  observeLocalPdfs: boolean // opt-in: use Chrome's local-PDF tab title for judging
  localPdfPolicyRevision: number // increments on every ON/OFF edge; invalidates stale async work
  // Browser fully quit + relaunched within RESTORE_GAP_MS → the in-flight session continues
  // seamlessly (경우 ①). OFF: any restart parks the session as resumable (경우 ②).
  sessionAutoContinue: boolean
}

export type SensitivityLevel = "lenient" | "standard" | "strict"

/** Preset tauOk values anchored to the O4 benchmark FPR sweep
 *  (docs/benchmarks/tier0-embedding-o4/operating_points.csv): lenient = FPR-15%
 *  point (0.5487), standard = the shipped FPR-10% default (0.5869 → 0.59, matches
 *  tier0.TAU_OK), strict = FPR-5% point (0.6765). Only three levels: Tier-1 rescue
 *  re-checks DRIFT but never OK, so strictness beyond this stops being felt. */
export const SENSITIVITY_PRESETS: Record<SensitivityLevel, number> = {
  lenient: 0.55,
  standard: 0.59,
  strict: 0.68,
}

/** The preset level whose tauOk is nearest to the given value. */
export function sensitivityLevelFor(tauOk: number): SensitivityLevel {
  let best: SensitivityLevel = "standard"
  let bestDist = Number.POSITIVE_INFINITY
  for (const level of Object.keys(SENSITIVITY_PRESETS) as SensitivityLevel[]) {
    const dist = Math.abs(SENSITIVITY_PRESETS[level] - tauOk)
    if (dist < bestDist) {
      best = level
      bestDist = dist
    }
  }
  return best
}

/** Snap an arbitrary tauOk (e.g. a legacy 0.01-step slider value) to the nearest preset. */
export function snapTauOk(tauOk: number): number {
  return SENSITIVITY_PRESETS[sensitivityLevelFor(tauOk)]
}

export const DEFAULT_SETTINGS: Settings = {
  tauOk: SENSITIVITY_PRESETS.standard,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  observeLocalPdfs: false,
  localPdfPolicyRevision: 0,
  sessionAutoContinue: true,
}

function coerce(value: Partial<Settings> | undefined): Settings {
  const q = value?.quietHours
  return {
    tauOk: typeof value?.tauOk === "number" ? snapTauOk(value.tauOk) : DEFAULT_SETTINGS.tauOk,
    quietHours: {
      enabled: Boolean(q?.enabled),
      start: typeof q?.start === "string" ? q.start : DEFAULT_SETTINGS.quietHours.start,
      end: typeof q?.end === "string" ? q.end : DEFAULT_SETTINGS.quietHours.end,
    },
    observeLocalPdfs: Boolean(value?.observeLocalPdfs),
    localPdfPolicyRevision:
      typeof value?.localPdfPolicyRevision === "number" &&
      Number.isSafeInteger(value.localPdfPolicyRevision) &&
      value.localPdfPolicyRevision >= 0
        ? value.localPdfPolicyRevision
        : DEFAULT_SETTINGS.localPdfPolicyRevision,
    // Default-true: Boolean(value?.x) would silently flip absent legacy records to false.
    sessionAutoContinue:
      typeof value?.sessionAutoContinue === "boolean"
        ? value.sessionAutoContinue
        : DEFAULT_SETTINGS.sessionAutoContinue,
  }
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  return coerce(stored[SETTINGS_KEY] as Partial<Settings> | undefined)
}

let settingsWriteQueue: Promise<void> = Promise.resolve()

export function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const operation = settingsWriteQueue.then(async () => {
    const current = await getSettings()
    const requested = coerce({ ...current, ...patch, quietHours: { ...current.quietHours, ...patch.quietHours } })
    const merged = {
      ...requested,
      // Callers cannot forge or roll back this token. Every policy edge invalidates async
      // observations, provider calls not yet started, and queued notifications from before it.
      localPdfPolicyRevision:
        current.localPdfPolicyRevision + (current.observeLocalPdfs === requested.observeLocalPdfs ? 0 : 1),
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged })
    return merged
  })
  settingsWriteQueue = operation.then(() => undefined, () => undefined)
  return operation
}

export async function localPdfPolicyMatches(revision: number): Promise<boolean> {
  const settings = await getSettings()
  return settings.observeLocalPdfs && settings.localPdfPolicyRevision === revision
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

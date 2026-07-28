// Multi-provider judge configuration (options mockup v6). Credentials and routing are
// separate concerns: `accounts` holds a key pool per connected provider (same rotation
// semantics the Ollama-only config had), `routes` names which provider+model each tier
// uses. Migrates from the legacy kibitzer:ollama:v2 record on first read; the legacy
// record is left in place so a rollback build keeps working.
//
// Model presets were verified 2026-07-28 — OpenRouter/Ollama Cloud against their live
// catalog APIs, the rest against vendor docs. Every non-Claude provider speaks the
// OpenAI chat.completions format, so the wire adapters stay at two (openai + claude);
// Ollama keeps its already-tested native /api/chat path.

export type ProviderId =
  | "ollama"
  | "gemini"
  | "openrouter"
  | "zai"
  | "deepseek"
  | "claude"
  | "openai"
  | "kimi"

export type WireFormat = "ollama" | "openai" | "claude"

export interface ProviderProfile {
  id: ProviderId
  label: string
  chatUrl: string
  format: WireFormat
  /** Options-UI key placeholder, e.g. "sk-or-v1-…". */
  keyHint: string
  /** One-line options-UI description (free quota, pricing feel, caveats). */
  note: string
  /** First entry is the tier default. Exact API model strings. */
  tier1Presets: readonly string[]
  tier2Presets: readonly string[]
  /** OpenAI-format wire quirks (only the "openai" vendor needs them today). */
  wire?: { maxTokensField?: "max_completion_tokens"; omitTemperature?: boolean }
}

/** Ordered by connect-picker recommendation (mockup v6 comparison table). */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: "ollama",
    label: "Ollama Cloud",
    chatUrl: "https://ollama.com/api/chat",
    format: "ollama",
    keyHint: "ollama.com API 키",
    note: "무료 계정 키만으로 충분 — 키가 여러 개면 자동 로테이션으로 무료 한도를 넓게 씁니다.",
    tier1Presets: ["nemotron-3-super", "nemotron-3-nano:30b", "gpt-oss:20b"],
    tier2Presets: ["minimax-m3", "qwen3.5:397b", "gemma4:31b"],
  },
  {
    id: "gemini",
    label: "Gemini",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    format: "openai",
    keyHint: "AIza…",
    note: "Google AI Studio 키 · Flash급 무료 쿼터(일 ~1,000회 수준, 변동) · 비한국계 중 한국어 최상급.",
    tier1Presets: ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite"],
    tier2Presets: ["gemini-3.6-flash", "gemini-3.1-flash-lite"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    format: "openai",
    keyHint: "sk-or-v1-…",
    note: "한 키로 300+ 모델 — 업체/모델 형식. :free 모델은 무료(기본 50회/일, $10 충전 시 1,000회/일).",
    tier1Presets: [
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "openai/gpt-oss-20b:free",
      "inclusionai/ling-2.6-flash",
    ],
    tier2Presets: [
      "upstage/solar-pro-3",
      "google/gemma-4-31b-it:free",
      "minimax/minimax-m3",
    ],
  },
  {
    id: "zai",
    label: "Z.ai GLM",
    chatUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    format: "openai",
    keyHint: "Z.ai API 키",
    note: "Zhipu GLM · glm-4.7-flash는 영구 무료(일 ~1,000회 수준) · OpenAI 호환.",
    tier1Presets: ["glm-4.7-flash", "glm-4.7-flashx"],
    tier2Presets: ["glm-4.7", "glm-5"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    chatUrl: "https://api.deepseek.com/v1/chat/completions",
    format: "openai",
    keyHint: "sk-…",
    note: "v4-flash 하나로 두 Tier 커버 · 캐시 히트 시 입력 $0.0028/1M · OpenAI 호환.",
    tier1Presets: ["deepseek-v4-flash"],
    tier2Presets: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "claude",
    label: "Claude",
    chatUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
    keyHint: "sk-ant-…",
    note: "Anthropic API 키 필요 (console.anthropic.com) · 사용량 과금.",
    tier1Presets: ["claude-haiku-4-5"],
    tier2Presets: ["claude-sonnet-5", "claude-opus-4-8"],
  },
  {
    id: "openai",
    label: "OpenAI",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    format: "openai",
    keyHint: "sk-…",
    note: "OpenAI API 키 필요 (developers.openai.com) · 사용량 과금.",
    tier1Presets: ["gpt-5.4-nano", "gpt-5-nano", "gpt-5.4-mini"],
    tier2Presets: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.4"],
    // gpt-5.x rejects `max_tokens` (wants max_completion_tokens) and non-default temperature.
    wire: { maxTokensField: "max_completion_tokens", omitTemperature: true },
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    chatUrl: "https://api.moonshot.ai/v1/chat/completions",
    format: "openai",
    keyHint: "sk-…",
    note: "무료 티어 없음 · $1 충전 전 분당 3회 제한 · OpenAI 호환 — 현재는 비추천.",
    tier1Presets: ["kimi-k2.6"],
    tier2Presets: ["kimi-k2.6", "kimi-k3"],
  },
]

export function profileFor(id: ProviderId): ProviderProfile {
  const profile = PROVIDER_PROFILES.find((p) => p.id === id)
  if (!profile) throw new Error(`unknown provider: ${id}`)
  return profile
}

const PROVIDER_IDS = new Set<string>(PROVIDER_PROFILES.map((p) => p.id))

// --- storage ---------------------------------------------------------------------

const SETTINGS_KEY = "kibitzer:providers:v1"
const LEGACY_OLLAMA_KEY = "kibitzer:ollama:v2"

export type TierName = "tier1" | "tier2"

export interface StoredKey {
  id: string
  /** Display name — empty means the UI shows "키 N". */
  name: string
  value: string
  addedAt: number
}

export interface ProviderAccount {
  /** Rotation pool — the adapter advances to the next key on 401/403/429. */
  keys: StoredKey[]
}

export interface TierRoute {
  provider: ProviderId
  model: string
}

export interface JudgeSettings {
  /** A provider is "connected" iff it has an entry here (keys may still be empty). */
  accounts: Partial<Record<ProviderId, ProviderAccount>>
  routes: { tier1: TierRoute; tier2: TierRoute }
}

export function defaultRoute(tier: TierName, provider: ProviderId = "ollama"): TierRoute {
  const profile = profileFor(provider)
  const presets = tier === "tier1" ? profile.tier1Presets : profile.tier2Presets
  return { provider, model: presets[0] }
}

function coerceKey(value: unknown): StoredKey | null {
  if (!value || typeof value !== "object") return null
  const k = value as Partial<StoredKey>
  if (typeof k.value !== "string" || !k.value.trim()) return null
  return {
    id: typeof k.id === "string" && k.id ? k.id : crypto.randomUUID(),
    name: typeof k.name === "string" ? k.name.trim() : "",
    value: k.value.trim(),
    addedAt: typeof k.addedAt === "number" ? k.addedAt : 0,
  }
}

function coerceRoute(value: unknown, tier: TierName): TierRoute {
  const r = (value ?? {}) as Partial<TierRoute>
  if (typeof r.provider !== "string" || !PROVIDER_IDS.has(r.provider)) {
    return defaultRoute(tier)
  }
  const provider = r.provider as ProviderId
  const model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : null
  return model ? { provider, model } : defaultRoute(tier, provider)
}

function coerce(value: unknown): JudgeSettings {
  const v = (value ?? {}) as Partial<JudgeSettings>
  const accounts: JudgeSettings["accounts"] = {}
  const rawAccounts = (v.accounts ?? {}) as Record<string, unknown>
  for (const [id, account] of Object.entries(rawAccounts)) {
    if (!PROVIDER_IDS.has(id)) continue
    const keys = Array.isArray((account as ProviderAccount | undefined)?.keys)
      ? (account as ProviderAccount).keys.map(coerceKey).filter((k): k is StoredKey => k !== null)
      : []
    accounts[id as ProviderId] = { keys }
  }
  // Ollama is the built-in default provider — always connected.
  accounts.ollama ??= { keys: [] }
  return {
    accounts,
    routes: {
      tier1: coerceRoute(v.routes?.tier1, "tier1"),
      tier2: coerceRoute(v.routes?.tier2, "tier2"),
    },
  }
}

/** One-time import of the legacy Ollama-only config (keys → rotation pool, models → routes). */
function fromLegacy(value: unknown): JudgeSettings {
  const legacy = (value ?? {}) as { apiKeys?: unknown; tier1Model?: unknown; tier2Model?: unknown }
  const now = Date.now()
  const keys: StoredKey[] = (Array.isArray(legacy.apiKeys) ? legacy.apiKeys : [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean)
    .map((value, index) => ({
      id: crypto.randomUUID(),
      name: `키 ${index + 1}`,
      value,
      addedAt: now,
    }))
  const model = (raw: unknown, tier: TierName): string =>
    typeof raw === "string" && raw.trim() ? raw.trim() : defaultRoute(tier).model
  return {
    accounts: { ollama: { keys } },
    routes: {
      tier1: { provider: "ollama", model: model(legacy.tier1Model, "tier1") },
      tier2: { provider: "ollama", model: model(legacy.tier2Model, "tier2") },
    },
  }
}

export async function getJudgeSettings(): Promise<JudgeSettings> {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_OLLAMA_KEY])
  if (stored[SETTINGS_KEY] !== undefined) return coerce(stored[SETTINGS_KEY])
  const migrated = coerce(
    stored[LEGACY_OLLAMA_KEY] !== undefined ? fromLegacy(stored[LEGACY_OLLAMA_KEY]) : {},
  )
  await chrome.storage.local.set({ [SETTINGS_KEY]: migrated })
  return migrated
}

async function saveJudgeSettings(settings: JudgeSettings): Promise<JudgeSettings> {
  const merged = coerce(settings)
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged })
  return merged
}

// --- mutations (options UI) ------------------------------------------------------

export async function connectProvider(provider: ProviderId): Promise<JudgeSettings> {
  const settings = await getJudgeSettings()
  settings.accounts[provider] ??= { keys: [] }
  return saveJudgeSettings(settings)
}

/** Disconnect removes the account AND its keys; tiers routed to it fall back to the
 *  Ollama defaults. Ollama itself is the built-in default and cannot be disconnected. */
export async function disconnectProvider(provider: ProviderId): Promise<JudgeSettings> {
  if (provider === "ollama") return getJudgeSettings()
  const settings = await getJudgeSettings()
  delete settings.accounts[provider]
  for (const tier of ["tier1", "tier2"] as const) {
    if (settings.routes[tier].provider === provider) {
      settings.routes[tier] = defaultRoute(tier)
    }
  }
  return saveJudgeSettings(settings)
}

export async function addProviderKey(
  provider: ProviderId,
  name: string,
  value: string,
): Promise<JudgeSettings> {
  const trimmed = value.trim()
  if (!trimmed) return getJudgeSettings()
  const settings = await getJudgeSettings()
  const account = (settings.accounts[provider] ??= { keys: [] })
  account.keys.push({
    id: crypto.randomUUID(),
    name: name.trim(),
    value: trimmed,
    addedAt: Date.now(),
  })
  return saveJudgeSettings(settings)
}

export async function removeProviderKey(
  provider: ProviderId,
  keyId: string,
): Promise<JudgeSettings> {
  const settings = await getJudgeSettings()
  const account = settings.accounts[provider]
  if (account) account.keys = account.keys.filter((k) => k.id !== keyId)
  return saveJudgeSettings(settings)
}

export async function setRoutes(
  routes: Partial<Record<TierName, Partial<TierRoute>>>,
): Promise<JudgeSettings> {
  const settings = await getJudgeSettings()
  for (const tier of ["tier1", "tier2"] as const) {
    const patch = routes[tier]
    if (!patch) continue
    settings.routes[tier] = coerceRoute({ ...settings.routes[tier], ...patch }, tier)
  }
  return saveJudgeSettings(settings)
}

// --- read-side helpers -----------------------------------------------------------

export function routeKeys(settings: JudgeSettings, tier: TierName): string[] {
  const account = settings.accounts[settings.routes[tier].provider]
  return (account?.keys ?? []).map((k) => k.value)
}

/** Key value shown in the UI: head + tail only, the middle never leaves the worker. */
export function maskKeyValue(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}····`
  return `${value.slice(0, 4)}····${value.slice(-4)}`
}

export interface PublicStoredKey {
  id: string
  name: string
  masked: string
  addedAt: number
}

export interface PublicJudgeSettings {
  accounts: Partial<Record<ProviderId, PublicStoredKey[]>>
  routes: { tier1: TierRoute; tier2: TierRoute }
}

export function toPublicSettings(settings: JudgeSettings): PublicJudgeSettings {
  const accounts: PublicJudgeSettings["accounts"] = {}
  for (const [id, account] of Object.entries(settings.accounts)) {
    accounts[id as ProviderId] = (account?.keys ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      masked: maskKeyValue(k.value),
      addedAt: k.addedAt,
    }))
  }
  return { accounts, routes: settings.routes }
}

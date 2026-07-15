export type ExplorationVerdict = "OK" | "DRIFT"
export type ExplorationResponseKind = "intervention" | "celebration"

export interface ExplorationHistoryEntry {
  id: string
  tabId?: number
  url: string
  title: string
  startedAt: number
  endedAt?: number
  observationDwellMs: number
  tier2DwellMs: number
  observationId?: string
  verdict?: ExplorationVerdict
  responseKind?: ExplorationResponseKind
}

export type ExplorationHistoryLoadResult =
  | { ok: true; entries: ExplorationHistoryEntry[] }
  | { ok: false }

const HISTORY_STORAGE_KEY = "kibitzer:exploration-history"
const MAX_HISTORY_ITEMS = 100
const MAX_HISTORY_TITLE_LENGTH = 2000
let historyMutationQueue: Promise<void> = Promise.resolve()

export async function listExplorationHistory(): Promise<ExplorationHistoryEntry[]> {
  const result = await chrome.storage.session.get(HISTORY_STORAGE_KEY)
  const value = result[HISTORY_STORAGE_KEY]
  if (!Array.isArray(value)) return []
  return value
    .filter(isHistoryEntry)
    .map(sanitizeHistoryEntry)
    .filter((entry): entry is ExplorationHistoryEntry => entry !== null)
}

export async function loadExplorationHistory(): Promise<ExplorationHistoryLoadResult> {
  try {
    return { ok: true, entries: await listExplorationHistory() }
  } catch {
    return { ok: false }
  }
}

export async function prependExplorationHistory(entry: ExplorationHistoryEntry): Promise<void> {
  const sanitized = sanitizeHistoryEntry(entry)
  if (!sanitized) return
  return enqueueHistoryMutation(async () => {
    const entries = await listExplorationHistory()
    const deduped = entries.filter((item) => item.id !== sanitized.id)
    await chrome.storage.session.set({
      [HISTORY_STORAGE_KEY]: [sanitized, ...deduped].slice(0, MAX_HISTORY_ITEMS),
    })
  })
}

export async function updateExplorationHistory(
  id: string,
  patch: Partial<ExplorationHistoryEntry>,
): Promise<void> {
  return enqueueHistoryMutation(async () => {
    const entries = await listExplorationHistory()
    const next = entries.flatMap((entry) => {
      if (entry.id !== id) return [entry]
      const sanitized = sanitizeHistoryEntry({ ...entry, ...patch })
      return sanitized ? [sanitized] : []
    })
    await chrome.storage.session.set({ [HISTORY_STORAGE_KEY]: next.slice(0, MAX_HISTORY_ITEMS) })
  })
}

export async function clearExplorationHistory(): Promise<void> {
  return enqueueHistoryMutation(async () => {
    await chrome.storage.session.remove(HISTORY_STORAGE_KEY)
  })
}

export function minimizeHistoryUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed.origin
  } catch {
    return null
  }
}

function sanitizeHistoryEntry(entry: ExplorationHistoryEntry): ExplorationHistoryEntry | null {
  const url = minimizeHistoryUrl(entry.url)
  if (!url) return null
  return {
    ...entry,
    url,
    title: entry.title.slice(0, MAX_HISTORY_TITLE_LENGTH),
  }
}

function enqueueHistoryMutation(mutation: () => Promise<void>): Promise<void> {
  const result = historyMutationQueue.then(mutation)
  historyMutationQueue = result.catch(() => undefined)
  return result
}

function isHistoryEntry(value: unknown): value is ExplorationHistoryEntry {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<ExplorationHistoryEntry>
  const tabIdValid = item.tabId === undefined || isFiniteNumber(item.tabId)
  const endedAtValid = item.endedAt === undefined || isFiniteNumber(item.endedAt)
  const observationIdValid = item.observationId === undefined || typeof item.observationId === "string"
  const verdictValid = item.verdict === undefined || item.verdict === "OK" || item.verdict === "DRIFT"
  const responseKindValid =
    item.responseKind === undefined || item.responseKind === "intervention" || item.responseKind === "celebration"
  return (
    typeof item.id === "string" &&
    tabIdValid &&
    typeof item.url === "string" &&
    typeof item.title === "string" &&
    isFiniteNumber(item.startedAt) &&
    endedAtValid &&
    isFiniteNumber(item.observationDwellMs) &&
    isFiniteNumber(item.tier2DwellMs) &&
    observationIdValid &&
    verdictValid &&
    responseKindValid
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

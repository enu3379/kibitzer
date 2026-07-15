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
let historyMutationQueue: Promise<void> = Promise.resolve()

export async function listExplorationHistory(): Promise<ExplorationHistoryEntry[]> {
  const result = await chrome.storage.session.get(HISTORY_STORAGE_KEY)
  const value = result[HISTORY_STORAGE_KEY]
  return Array.isArray(value) ? value.filter(isHistoryEntry) : []
}

export async function loadExplorationHistory(): Promise<ExplorationHistoryLoadResult> {
  try {
    return { ok: true, entries: await listExplorationHistory() }
  } catch {
    return { ok: false }
  }
}

export async function prependExplorationHistory(entry: ExplorationHistoryEntry): Promise<void> {
  return enqueueHistoryMutation(async () => {
    const entries = await listExplorationHistory()
    const deduped = entries.filter((item) => item.id !== entry.id)
    await chrome.storage.session.set({
      [HISTORY_STORAGE_KEY]: [entry, ...deduped].slice(0, MAX_HISTORY_ITEMS),
    })
  })
}

export async function updateExplorationHistory(
  id: string,
  patch: Partial<ExplorationHistoryEntry>,
): Promise<void> {
  return enqueueHistoryMutation(async () => {
    const entries = await listExplorationHistory()
    const next = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
    await chrome.storage.session.set({ [HISTORY_STORAGE_KEY]: next.slice(0, MAX_HISTORY_ITEMS) })
  })
}

function enqueueHistoryMutation(mutation: () => Promise<void>): Promise<void> {
  const result = historyMutationQueue.then(mutation)
  historyMutationQueue = result.catch(() => undefined)
  return result
}

export async function updateExplorationHistoryByObservationId(
  observationId: string,
  patch: Partial<ExplorationHistoryEntry>,
): Promise<void> {
  return enqueueHistoryMutation(async () => {
    const entries = await listExplorationHistory()
    const next = entries.map((entry) =>
      entry.observationId === observationId ? { ...entry, ...patch } : entry,
    )
    await chrome.storage.session.set({ [HISTORY_STORAGE_KEY]: next.slice(0, MAX_HISTORY_ITEMS) })
  })
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

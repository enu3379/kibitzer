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

const HISTORY_STORAGE_KEY = "kibitzer:exploration-history"
const MAX_HISTORY_ITEMS = 100
let historyMutationQueue: Promise<void> = Promise.resolve()

export async function listExplorationHistory(): Promise<ExplorationHistoryEntry[]> {
  const result = await chrome.storage.session.get(HISTORY_STORAGE_KEY)
  const value = result[HISTORY_STORAGE_KEY]
  return Array.isArray(value) ? value.filter(isHistoryEntry) : []
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

function isHistoryEntry(value: unknown): value is ExplorationHistoryEntry {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<ExplorationHistoryEntry>
  const responseKindValid =
    item.responseKind === undefined || item.responseKind === "intervention" || item.responseKind === "celebration"
  return (
    typeof item.id === "string" &&
    typeof item.url === "string" &&
    typeof item.title === "string" &&
    typeof item.startedAt === "number" &&
    responseKindValid
  )
}

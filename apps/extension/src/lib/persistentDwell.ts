export const DWELL_RECORD_VERSION = 1

const RECORD_PREFIX = "kibitzer:dwell:"
const CURRENT_TOKEN_PREFIX = "kibitzer:dwell-current:"
const RETRY_DELAY_MS = 5000
const SHORT_TIMER_MAX_MS = 25000

interface DwellRecordBase {
  version: typeof DWELL_RECORD_VERSION
  token: string
  tabId: number
  url: string
  dueAt: number
  historyId: string
}

export interface ObservationDwellRecord extends DwellRecordBase {
  stage: "observation"
  startedAt: number
  tier2DwellMs: number
}

export interface Tier2DwellRecord extends DwellRecordBase {
  stage: "tier2"
  observationId: string
}

export type DwellRecord = ObservationDwellRecord | Tier2DwellRecord
export type DwellOutcome = "complete" | "cancel" | "retry"

type DueHandler = (record: DwellRecord) => Promise<DwellOutcome>
type CancelHandler = (record: DwellRecord) => Promise<void>

export class PersistentDwellScheduler {
  private readonly timers = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly onDue: DueHandler
  private readonly onCancel: CancelHandler

  constructor(onDue: DueHandler, onCancel: CancelHandler) {
    this.onDue = onDue
    this.onCancel = onCancel
  }

  async startNavigation(tabId: number, token: string): Promise<void> {
    await chrome.storage.session.set({ [currentTokenKey(tabId)]: token })
    const records = await listRecords()
    await Promise.all(
      records
        .filter((record) => record.tabId === tabId && record.token !== token)
        .map((record) => this.cancelRecord(record)),
    )
  }

  async schedule(record: DwellRecord): Promise<boolean> {
    if (!(await tokenIsCurrent(record))) return false
    const key = recordKey(record)
    await chrome.storage.session.set({ [key]: record })
    await this.arm(record)
    return true
  }

  async restore(): Promise<void> {
    for (const record of await listRecords()) {
      if (await tokenIsCurrent(record)) {
        await this.arm(record)
      } else {
        await this.cancelRecord(record)
      }
    }
  }

  async handleAlarm(name: string): Promise<boolean> {
    if (!name.startsWith(RECORD_PREFIX)) return false
    await this.run(name)
    return true
  }

  async cancelTab(tabId: number): Promise<void> {
    const records = (await listRecords()).filter((record) => record.tabId === tabId)
    await Promise.all(records.map((record) => this.cancelRecord(record)))
    await chrome.storage.session.remove(currentTokenKey(tabId))
  }

  async cancelOtherTabs(activeTabId: number): Promise<void> {
    const records = (await listRecords()).filter((record) => record.tabId !== activeTabId)
    await Promise.all(records.map((record) => this.cancelRecord(record)))
  }

  private async run(name: string): Promise<void> {
    if (this.running.has(name)) return
    this.running.add(name)
    try {
      await this.runOnce(name)
    } finally {
      this.running.delete(name)
    }
  }

  private async runOnce(name: string): Promise<void> {
    const record = await loadRecord(name)
    if (!record) return
    if (!(await tokenIsCurrent(record))) {
      await this.cancelRecord(record)
      return
    }
    if (record.dueAt > Date.now()) {
      await this.arm(record)
      return
    }

    let outcome: DwellOutcome
    try {
      outcome = await this.onDue(record)
    } catch (error) {
      console.warn("kibitzer: dwell stage failed; retrying", error)
      outcome = "retry"
    }

    if (outcome === "retry") {
      await this.schedule({ ...record, dueAt: Date.now() + RETRY_DELAY_MS })
      return
    }
    if (outcome === "cancel") await this.onCancel(record)
    await this.removeRecord(record)
  }

  private async arm(record: DwellRecord): Promise<void> {
    const key = recordKey(record)
    await chrome.alarms.create(key, { when: Math.max(record.dueAt, Date.now() + 1) })
    const previousTimer = this.timers.get(key)
    if (previousTimer !== undefined) clearTimeout(previousTimer)
    const delay = Math.max(0, record.dueAt - Date.now())
    if (delay > SHORT_TIMER_MAX_MS) {
      this.timers.delete(key)
      return
    }
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(key)
      return this.run(key).catch((error) => {
        console.warn("kibitzer: dwell timer failed", error)
      })
    }, delay)
    this.timers.set(key, timer)
  }

  private async cancelRecord(record: DwellRecord): Promise<void> {
    await this.onCancel(record)
    await this.removeRecord(record)
  }

  private async removeRecord(record: DwellRecord): Promise<void> {
    const key = recordKey(record)
    const timer = this.timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(key)
    await Promise.all([chrome.storage.session.remove(key), chrome.alarms.clear(key)])
  }
}

export function recordKey(record: Pick<DwellRecord, "stage" | "token">): string {
  return `${RECORD_PREFIX}${record.stage}:${record.token}`
}

async function loadRecord(key: string): Promise<DwellRecord | null> {
  const stored = await chrome.storage.session.get(key)
  return isDwellRecord(stored[key]) ? stored[key] : null
}

async function listRecords(): Promise<DwellRecord[]> {
  const stored = await chrome.storage.session.get(null)
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(RECORD_PREFIX))
    .map(([, value]) => value)
    .filter(isDwellRecord)
}

async function tokenIsCurrent(record: DwellRecord): Promise<boolean> {
  const key = currentTokenKey(record.tabId)
  const stored = await chrome.storage.session.get(key)
  return stored[key] === record.token
}

function currentTokenKey(tabId: number): string {
  return `${CURRENT_TOKEN_PREFIX}${tabId}`
}

function isDwellRecord(value: unknown): value is DwellRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<DwellRecord>
  const baseValid =
    record.version === DWELL_RECORD_VERSION &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    isFiniteNumber(record.tabId) &&
    typeof record.url === "string" &&
    isFiniteNumber(record.dueAt) &&
    typeof record.historyId === "string"
  if (!baseValid) return false
  if (record.stage === "observation") {
    return isFiniteNumber(record.startedAt) && isFiniteNumber(record.tier2DwellMs)
  }
  return (
    record.stage === "tier2" &&
    typeof record.observationId === "string"
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export const D7_REVIEW_ALARM_PREFIX = "kibitzer:d7-review:"

// Stay below MV3's roughly 30-second idle window while covering alarms whose
// sub-30-second `when` may be rounded up by Chrome.
const SHORT_TIMER_MAX_MS = 29000

type DueHandler = (observationId: string) => Promise<void>

export class D7ReviewScheduler {
  private readonly timers = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly onDue: DueHandler

  constructor(onDue: DueHandler) {
    this.onDue = onDue
  }

  async schedule(observationId: string, delaySeconds: number): Promise<void> {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 1) return
    const name = d7ReviewAlarmName(observationId)
    const dueAt = Date.now() + Math.ceil(delaySeconds * 1000)
    await this.clear(observationId)
    await chrome.alarms.create(name, { when: dueAt })

    const delay = Math.max(0, dueAt - Date.now())
    if (delay > SHORT_TIMER_MAX_MS) return
    const timer = globalThis.setTimeout(() => {
      this.timers.delete(name)
      void this.run(name)
    }, delay)
    this.timers.set(name, timer)
  }

  async clear(observationId: string): Promise<void> {
    const name = d7ReviewAlarmName(observationId)
    const timer = this.timers.get(name)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(name)
    await chrome.alarms.clear(name)
  }

  async handleAlarm(name: string): Promise<boolean> {
    if (!isD7ReviewAlarmName(name)) return false
    await this.run(name)
    return true
  }

  private async run(name: string): Promise<void> {
    if (this.running.has(name)) return
    this.running.add(name)
    try {
      const timer = this.timers.get(name)
      if (timer !== undefined) clearTimeout(timer)
      this.timers.delete(name)
      await chrome.alarms.clear(name)
      await this.onDue(observationIdFromAlarmName(name))
    } catch (error) {
      console.warn("kibitzer: D7 review check failed", error)
    } finally {
      this.running.delete(name)
    }
  }
}

export function d7ReviewAlarmName(observationId: string): string {
  return `${D7_REVIEW_ALARM_PREFIX}${encodeURIComponent(observationId)}`
}

export function isD7ReviewAlarmName(name: string): boolean {
  return name.startsWith(D7_REVIEW_ALARM_PREFIX)
}

function observationIdFromAlarmName(name: string): string {
  return decodeURIComponent(name.slice(D7_REVIEW_ALARM_PREFIX.length))
}

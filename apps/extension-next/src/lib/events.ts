// Structured, durable event log — the queryable audit trail of what the detector decided
// and why (verdicts, scores, tier reached, Tier-2 decisions, nags, feedback, goal
// changes). Unlike the free-text klog ring buffer, these are typed records in the
// IndexedDB SSOT, so they can drive session analytics (P3-3) and offline replay (P3-6).

import { addRecord, clearStore, EVENT_STORE, getAllRecords } from "./db.ts"

const EVENT_CAP = 2000

export interface KibitzerEvent {
  id?: number
  ts: number
  type: string
  data: Record<string, unknown>
}

/** Append an event. Fire-and-forget: logging never blocks or breaks the pipeline. */
export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  void addRecord(EVENT_STORE, { ts: Date.now(), type, data }, EVENT_CAP).catch(() => undefined)
}

export async function getEvents(): Promise<KibitzerEvent[]> {
  return getAllRecords<KibitzerEvent>(EVENT_STORE)
}

export async function clearEvents(): Promise<void> {
  await clearStore(EVENT_STORE)
}

/** The event log as JSON Lines (one record per line), newest last. */
export async function eventsJsonl(): Promise<string> {
  return (await getEvents()).map((event) => JSON.stringify(event)).join("\n")
}

/** Write the event log to ~/Downloads/kibitzer-events.jsonl for offline analysis / replay. */
export async function exportEvents(): Promise<{ ok: boolean; error?: string }> {
  try {
    const text = (await eventsJsonl()) || ""
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`
    await chrome.downloads.download({
      url,
      filename: "kibitzer-events.jsonl",
      conflictAction: "overwrite",
      saveAs: false,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

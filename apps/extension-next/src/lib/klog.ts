// Debug log that survives outside DevTools: every klog() line goes to the service-worker
// console AND a ring buffer in chrome.storage.local, so it can be shown in the popup or
// exported to a file (~/Downloads/kibitzer-debug.log) that can be read directly off disk.

import { expectDownload, EXPORT_MIME } from "./downloadName.ts"

const LOG_KEY = "kibitzer:logs:v1"
const CAP = 400

export const DEBUG_LOG_FILENAME = "kibitzer-debug.log"

export interface LogEntry {
  t: number // epoch ms
  m: string
}

// Serialize appends so concurrent klog() calls don't clobber the buffer (storage.set is
// last-write-wins). Each append reads → pushes → writes on the tail of this chain.
let queue: Promise<void> = Promise.resolve()

export function klog(message: string): void {
  console.log(`[kbz] ${message}`)
  // Provider adapters also run in Node-based unit tests and tooling, where the
  // extension storage API does not exist. Console diagnostics still work there.
  if (typeof chrome === "undefined") return
  const entry: LogEntry = { t: Date.now(), m: message }
  queue = queue.then(async () => {
    const stored = await chrome.storage.local.get(LOG_KEY)
    const log = Array.isArray(stored[LOG_KEY]) ? (stored[LOG_KEY] as LogEntry[]) : []
    log.push(entry)
    await chrome.storage.local.set({ [LOG_KEY]: log.slice(-CAP) })
  }, () => undefined)
}

export async function readLog(): Promise<LogEntry[]> {
  await queue
  const stored = await chrome.storage.local.get(LOG_KEY)
  return Array.isArray(stored[LOG_KEY]) ? (stored[LOG_KEY] as LogEntry[]) : []
}

export async function clearLog(): Promise<void> {
  // Keep clearing in the same ordering chain as appends. Otherwise a pending raw
  // response write can land after remove() and resurrect content the user cleared.
  const pending = queue.then(
    () => chrome.storage.local.remove(LOG_KEY),
    () => chrome.storage.local.remove(LOG_KEY),
  )
  // The shared chain must stay settled: readLog() awaits it, so a failed remove would
  // otherwise reject every later read. The caller still sees the original failure.
  queue = pending.catch(() => undefined)
  await pending
}

function hhmmss(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The buffer as plain text, newest last. */
export async function logText(): Promise<string> {
  return (await readLog()).map((e) => `${hhmmss(e.t)}  ${e.m}`).join("\n")
}

/** Write the buffer to ~/Downloads/kibitzer-debug.log (overwriting) so it can be read
 *  directly off disk. Returns the download filename or an error string. */
export async function exportLog(): Promise<{ ok: boolean; error?: string }> {
  try {
    const text = (await logText()) || "(empty)"
    const url = `data:${EXPORT_MIME};charset=utf-8,${encodeURIComponent(text)}`
    // Chrome renames this to 다운로드.txt without both halves of the fix — see downloadName.ts.
    expectDownload(url, DEBUG_LOG_FILENAME)
    await chrome.downloads.download({
      url,
      filename: DEBUG_LOG_FILENAME,
      conflictAction: "overwrite",
      saveAs: false,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

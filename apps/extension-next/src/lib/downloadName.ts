// Keeps exported files named the way we asked for them. Chrome fights this on two fronts.
//
// 1. The `filename` handed to chrome.downloads.download() is thrown away the moment a
//    Save-As dialog opens (the user has "ask where to save each file" on), and the name is
//    rebuilt from scratch — on Windows that gave "다운로드.txt"/"다운로드.customization".
//    onDeterminingFilename fires before either the silent or the dialog path picks a name,
//    so a suggestion made here survives both.
// 2. Even then Chrome replaces the *extension* with its preferred one for the download's
//    MIME type, which turned kibitzer-debug.log into .txt and kibitzer-events.jsonl into
//    .customization (the Windows registry's answer for application/json). Hence the
//    exports declare EXPORT_MIME below: octet-stream has no preferred extension, so the
//    suggested one is left alone.

/** MIME type for export data: URLs — anything more specific renames our extension. */
export const EXPORT_MIME = "application/octet-stream"

// Keyed by the full data: URL, so the two exports can never claim each other's name even
// though they now share the same (MIME-derived) prefix. Entries are transient: each is
// consumed by the download it was announced for.
const pending = new Map<string, string>()

/** Announcements outlive their download only when it never starts (an error before the
 *  event fires). Cap the map so those cannot accumulate in a long-lived worker. */
const MAX_PENDING = 4

/** Announce the name an about-to-start download should end up with. */
export function expectDownload(url: string, filename: string): void {
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next()
    if (!oldest.done) pending.delete(oldest.value)
  }
  pending.set(url, filename)
}

/** The announced name for a starting download, consumed so it applies exactly once.
 *  DownloadItem.url may be truncated for a URL this long, so a prefix counts as a match. */
export function takeExpectedFilename(url: string): string | undefined {
  for (const [announced, filename] of pending) {
    if (announced === url || announced.startsWith(url) || url.startsWith(announced)) {
      pending.delete(announced)
      return filename
    }
  }
  return undefined
}

/** Rename our own exports as they start; leave every other download untouched. */
export function registerDownloadNaming(): void {
  // Not available in Node-based tests, and Firefox-style builds may lack the event.
  if (typeof chrome === "undefined" || !chrome.downloads?.onDeterminingFilename) return
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const filename = takeExpectedFilename(item.url)
    if (filename === undefined) {
      suggest()
      return
    }
    suggest({ filename, conflictAction: "overwrite" })
  })
}

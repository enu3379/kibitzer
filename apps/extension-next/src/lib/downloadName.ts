// Keeps exported files named the way we asked for them.
//
// Both exports hand chrome.downloads.download() a `data:` URL plus a `filename`. Chrome
// honours that name for a silent download, but as soon as a Save-As dialog opens (the
// user has "ask where to save each file" on) it throws the suggestion away and rebuilds a
// name from the MIME type — on Windows that means "다운로드.txt" for text/plain and, via a
// registry lookup, "다운로드.customization" for application/json. onDeterminingFilename
// fires before either path picks a name, so a suggestion made there survives the dialog.

const pending = new Map<string, string>()

/** How much of the data: URL identifies it. Long enough to be unique between our two
 *  exports, short enough that a truncated DownloadItem.url still matches. */
const KEY_LEN = 48

const keyOf = (url: string): string => url.slice(0, KEY_LEN)

/** Announce the name an about-to-start download should end up with. */
export function expectDownload(url: string, filename: string): void {
  pending.set(keyOf(url), filename)
}

/** The announced name for a starting download, consumed so it applies exactly once. */
export function takeExpectedFilename(url: string): string | undefined {
  const key = keyOf(url)
  const filename = pending.get(key)
  if (filename !== undefined) pending.delete(key)
  return filename
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

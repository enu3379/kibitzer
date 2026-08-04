import { describeObservableUrl } from "./url.ts"
import { getSettings } from "./settings.ts"

export const LOCAL_PDF_PROMPT_SHOWN_KEY = "kibitzer:local-pdf-prompt-shown:v1"
/** Delay after the PDF is observed, so Chrome's PDF viewer can finish appearing first. */
export const LOCAL_PDF_PROMPT_DELAY_MS = 1000
export const LOCAL_PDF_PROMPT_WIDTH = 380
export const LOCAL_PDF_PROMPT_CONTENT_HEIGHT = 250
// chrome.windows.create() measures the outer frame, so add room for the native title bar
// while preserving the reviewed 380x250 content surface.
const NATIVE_FRAME_HEIGHT = 30
export const LOCAL_PDF_PROMPT_HEIGHT = LOCAL_PDF_PROMPT_CONTENT_HEIGHT + NATIVE_FRAME_HEIGHT
const WINDOW_MARGIN = 18
const PROMPT_PATH = "localPdfPrompt/localPdfPrompt.html"

type WindowBounds = Pick<chrome.windows.Window, "left" | "top" | "width" | "height">

export function localPdfPromptPosition(parent: WindowBounds): { left?: number; top?: number } {
  if (
    parent.left == null ||
    parent.top == null ||
    parent.width == null ||
    parent.height == null
  ) return {}
  return {
    left: Math.round(Math.max(parent.left, parent.left + parent.width - LOCAL_PDF_PROMPT_WIDTH - WINDOW_MARGIN)),
    top: Math.round(Math.max(parent.top, parent.top + parent.height - LOCAL_PDF_PROMPT_HEIGHT - WINDOW_MARGIN)),
  }
}

let opening: Promise<void> | null = null

export function maybeOpenLocalPdfPrompt(expectedPageKey: string): Promise<void> {
  if (opening) return opening
  opening = openLocalPdfPrompt(expectedPageKey).finally(() => {
    opening = null
  })
  return opening
}

async function openLocalPdfPrompt(expectedPageKey: string): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_PDF_PROMPT_SHOWN_KEY)
  if (stored[LOCAL_PDF_PROMPT_SHOWN_KEY]) return

  const promptBaseUrl = chrome.runtime.getURL(PROMPT_PATH)
  const popupWindows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] })
  const existingPrompt = popupWindows.some((window) =>
    window.tabs?.some((tab) =>
      tab.url?.startsWith(promptBaseUrl) || tab.pendingUrl?.startsWith(promptBaseUrl),
    ),
  )
  if (existingPrompt) {
    // Recovery path: the worker may have stopped after creating the popup but before
    // persisting SHOWN. Recognize that window instead of opening a duplicate.
    await chrome.storage.local.set({ [LOCAL_PDF_PROMPT_SHOWN_KEY]: Date.now() })
    return
  }

  await new Promise<void>((resolve) => setTimeout(resolve, LOCAL_PDF_PROMPT_DELAY_MS))
  const delayedState = await chrome.storage.local.get(LOCAL_PDF_PROMPT_SHOWN_KEY)
  if (delayedState[LOCAL_PDF_PROMPT_SHOWN_KEY] || (await getSettings()).observeLocalPdfs) return

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id == null || tab.windowId == null || !tab.url) return
  const descriptor = describeObservableUrl(tab.url)
  if (descriptor?.kind !== "local_pdf" || descriptor.pageKey !== expectedPageKey) return

  const parent = await chrome.windows.get(tab.windowId)
  const promptUrl = new URL(promptBaseUrl)
  promptUrl.searchParams.set("tabId", String(tab.id))
  await chrome.windows.create({
    url: promptUrl.href,
    type: "popup",
    focused: true,
    width: LOCAL_PDF_PROMPT_WIDTH,
    height: LOCAL_PDF_PROMPT_HEIGHT,
    ...localPdfPromptPosition(parent),
  })
  // Commit only after successful creation. If the worker stops before this write, the
  // existing-window recovery above closes the remaining create/commit gap on next wake.
  await chrome.storage.local.set({ [LOCAL_PDF_PROMPT_SHOWN_KEY]: Date.now() })
}

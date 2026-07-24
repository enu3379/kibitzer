// Play the toast chime from the service worker via an offscreen document (autoplay-safe).

import { klog } from "./klog.ts"

let ensuring: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Play a short chime when a Kibitzer nudge or celebration appears.",
  })
}

export async function playChime(kind: "intervention" | "celebration"): Promise<void> {
  try {
    // Serialize creation so two near-simultaneous nudges don't both createDocument.
    ensuring ??= ensureOffscreen().finally(() => {
      ensuring = null
    })
    await ensuring
    await chrome.runtime.sendMessage({ type: "kbz-chime", kind })
  } catch (error) {
    klog(`chime error: ${String(error)}`)
  }
}

/** Read the nudge aloud via Web Speech, hosted in the offscreen document. */
export async function speak(text: string): Promise<void> {
  try {
    ensuring ??= ensureOffscreen().finally(() => {
      ensuring = null
    })
    await ensuring
    await chrome.runtime.sendMessage({ type: "kbz-speak", text })
  } catch (error) {
    klog(`speak error: ${String(error)}`)
  }
}

const SOUNDS: Record<string, string> = {
  ding: "ding.wav",
  celebrate: "celebrate.wav",
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; sound?: string } | undefined) => {
    if (message?.type === "kibitzer:play-sound") {
      const file = SOUNDS[message.sound ?? "ding"] ?? SOUNDS.ding
      void new Audio(file).play().catch(() => undefined)
    }
  },
)

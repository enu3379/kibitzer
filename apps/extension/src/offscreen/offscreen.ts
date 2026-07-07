chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
  if (message?.type === "kibitzer:play-sound") {
    void new Audio("ding.wav").play().catch(() => undefined)
  }
})

import { LOCAL_PDF_PROMPT_COPY as copy } from "./copy.ts"

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const eyebrow = $<HTMLParagraphElement>("eyebrow")
const question = $<HTMLHeadingElement>("question")
const disclosure = $<HTMLParagraphElement>("disclosure")
const decline = $<HTMLButtonElement>("decline")
const enable = $<HTMLButtonElement>("enable")
const status = $<HTMLParagraphElement>("status")

eyebrow.textContent = copy.eyebrow
question.textContent = copy.question
disclosure.textContent = copy.disclosure
decline.textContent = copy.decline
enable.textContent = copy.enable

const sourceTabId = Number.parseInt(new URLSearchParams(location.search).get("tabId") ?? "", 10)

decline.addEventListener("click", () => window.close())
enable.addEventListener("click", async () => {
  decline.disabled = true
  enable.disabled = true
  status.classList.remove("error")
  status.textContent = copy.enabling
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "enable-local-pdf-observation",
      sourceTabId,
    })) as { ok?: boolean; settingEnabled?: boolean }
    if (!response?.ok) throw new EnableError(response ?? {})
    status.textContent = copy.enabled
    window.setTimeout(() => window.close(), 650)
  } catch (error) {
    status.classList.add("error")
    const response = error instanceof EnableError ? error.response : null
    status.textContent = response?.settingEnabled ? copy.partialError : copy.error
    decline.disabled = false
    enable.disabled = false
  }
})

class EnableError extends Error {
  constructor(readonly response: { ok?: boolean; settingEnabled?: boolean }) {
    super("enable failed")
  }
}

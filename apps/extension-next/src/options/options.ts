// Options page: sensitivity, quiet hours, persona, AI judge providers, and data
// controls. All state lives in the service worker; this page just reads/writes via
// messages — key values travel INTO the worker only, responses carry masked keys.

import { sampleLinesFor } from "../lib/personaSampleLines.ts"
import {
  defaultProviderKeyName,
  PROVIDER_PROFILES,
  type ProviderId,
  type TierName,
} from "../lib/providers.ts"

import {
  DISABLED_COPY,
  INCOMPLETE_COPY,
  effectiveAiEnabled,
  incompleteTiers,
  isAiConfigComplete,
} from "./aiTabState.ts"

import {
  SENSITIVITY_PRESETS,
  sensitivityLevelFor,
  type SensitivityLevel,
  type Settings,
} from "../lib/settings.ts"

interface StateResponse {
  persona?: string
  personas?: Array<{ key: string; name: string; tier?: "default" | "lab" }>
  health?: ProviderHealthSnapshot
}
interface TierHealth {
  ok: boolean
  message: string
}
interface ProviderHealthSnapshot {
  tier1: TierHealth | null
  tier2: TierHealth | null
}
interface PublicKeyInfo {
  id: string
  name: string
  masked: string
  addedAt: number
}
interface TierRoute {
  provider: ProviderId
  model: string
}
interface JudgeView {
  accounts: Partial<Record<ProviderId, PublicKeyInfo[]>>
  routes: { tier1: TierRoute; tier2: TierRoute }
}
interface RouteTestResult {
  ok: boolean
  detail: string
}
interface UsageRow {
  provider: ProviderId
  model: string
  calls: number
  tokensIn: number
  tokensOut: number
}
interface DomainLists {
  block: string[]
  allow: string[]
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const sens = $<HTMLElement>("sens")
const sensHint = $<HTMLElement>("sensHint")
const quietSw = $<HTMLButtonElement>("quietSw")
const quietStart = $<HTMLInputElement>("quietStart")
const quietEnd = $<HTMLInputElement>("quietEnd")
const localPdfSw = $<HTMLButtonElement>("localPdfSw")
const restoreSw = $<HTMLButtonElement>("restoreSw")
const blockList = $<HTMLTextAreaElement>("blockList")
const allowList = $<HTMLTextAreaElement>("allowList")
const blockCount = $<HTMLElement>("blockCount")
const allowCount = $<HTMLElement>("allowCount")
const siteResult = $<HTMLElement>("siteResult")
const pgrid = $<HTMLElement>("pgrid")
const pgridLab = $<HTMLElement>("pgridLab")
const pquote = $<HTMLElement>("pquote")
const pquoteTag = $<HTMLElement>("pquoteTag")
const pquoteTxt = $<HTMLElement>("pquoteTxt")
const ajProviders = $<HTMLElement>("ajProviders")
const ajConnect = $<HTMLElement>("ajConnect")
const ajAlerts = $<HTMLElement>("ajAlerts")
const ajUsage = $<HTMLElement>("ajUsage")
const ajSave = $<HTMLButtonElement>("ajSave")
const ajEnabled = $<HTMLButtonElement>("ajEnabled")
const ajResult = $<HTMLElement>("ajResult")
const exportLog = $<HTMLButtonElement>("exportLog")
const exportEvents = $<HTMLButtonElement>("exportEvents")
const wipe = $<HTMLButtonElement>("wipe")

const send = (msg: unknown): Promise<unknown> => chrome.runtime.sendMessage(msg)
const setChecked = (el: HTMLElement, on: boolean): void => el.setAttribute("aria-checked", String(on))
const isChecked = (el: HTMLElement): boolean => el.getAttribute("aria-checked") === "true"

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await send({ type: "set-settings", settings: patch })
}

const SENS_HINTS: Record<SensitivityLevel, string> = {
  lenient: "확실히 벗어났을 때만 이탈로 봅니다. 훈수가 줄어듭니다.",
  standard: "권장 기본값 — 대부분의 상황에 적합합니다.",
  strict: "조금만 벗어나도 이탈로 봅니다. 훈수가 잦아질 수 있습니다.",
}

function renderSensitivity(level: SensitivityLevel): void {
  sens.querySelectorAll<HTMLElement>(".segbtn").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.level === level)),
  )
  sensHint.textContent = SENS_HINTS[level]
}

// --- init ------------------------------------------------------------------------

async function init(): Promise<void> {
  const settings = (await send({ type: "get-settings" })) as Settings
  aiPreference = settings.aiJudgmentEnabled
  renderSensitivity(sensitivityLevelFor(settings.tauOk))
  setChecked(quietSw, settings.quietHours.enabled)
  quietStart.value = settings.quietHours.start
  quietEnd.value = settings.quietHours.end
  quietStart.disabled = quietEnd.disabled = !settings.quietHours.enabled
  setChecked(localPdfSw, settings.observeLocalPdfs)
  setChecked(restoreSw, settings.sessionAutoContinue)
  renderDomainLists((await send({ type: "get-domain-lists" })) as DomainLists)

  const state = (await send({ type: "get-state" })) as StateResponse
  runtimeHealth = state.health ?? { tier1: null, tier2: null }
  if (state?.personas) {
    renderPersonas(state.personas, state.persona)
  }
  const judgeView = (await send({ type: "get-judge-settings" })) as JudgeView
  applyJudge(judgeView)
  await loadUsage()
}

// --- persona picker ----------------------------------------------------------------

// The quote strip does double duty: hovering or focusing a card previews that voice,
// leaving the card restores whatever is actually selected. Selecting commits the
// persona's "accepting the job" line and flashes the strip so the click lands.
let selectedPersona: { key: string; name: string } | null = null

// Bumped on every click so a slow set-persona round trip can't repaint the strip after a
// later click already did. Without it, clicking A then B repaints whichever reply lands
// last, which is not necessarily B.
let clickToken = 0

function paintQuote(key: string, name: string, preview: boolean): void {
  // personaSampleLines.ts is hand-maintained while personas.data.ts is generated, so a new
  // persona can reach the picker before its copy does. Paint the name regardless — bailing
  // out would leave the previous persona's line sitting under a different hovered card.
  const lines = sampleLinesFor(key)
  pquote.classList.toggle("preview", preview)
  pquoteTag.textContent = `${preview ? "미리보기" : "선택됨"} · ${name}`
  pquoteTxt.textContent = lines ? `“${preview ? lines.hover : lines.picked}”` : ""
  pquoteTxt.classList.remove("swap")
  void pquoteTxt.offsetWidth // restart the fade
  pquoteTxt.classList.add("swap")
}

function restoreQuote(): void {
  if (selectedPersona) paintQuote(selectedPersona.key, selectedPersona.name, false)
}

function flashQuote(): void {
  pquote.classList.remove("fire")
  void pquote.offsetWidth
  pquote.classList.add("fire")
}

function renderPersonas(
  personas: Array<{ key: string; name: string; tier?: "default" | "lab" }>,
  current?: string,
): void {
  pgrid.innerHTML = ""
  pgridLab.innerHTML = ""
  // One shared card list across both grids, so selecting in one tier deselects the other.
  const cards: HTMLButtonElement[] = []
  for (const p of personas) {
    const b = document.createElement("button")
    b.className = "pcard"
    b.setAttribute("aria-pressed", String(p.key === current))
    b.dataset.key = p.key
    b.innerHTML = `<span class="pn">${p.name}</span>`
    if (p.key === current) selectedPersona = { key: p.key, name: p.name }

    const preview = (): void => paintQuote(p.key, p.name, true)
    b.addEventListener("mouseenter", preview)
    b.addEventListener("focus", preview)
    b.addEventListener("mouseleave", restoreQuote)
    b.addEventListener("blur", restoreQuote)

    b.addEventListener("click", async () => {
      const token = ++clickToken
      await send({ type: "set-persona", persona: p.key })
      if (token !== clickToken) return // a later click already owns the strip
      selectedPersona = { key: p.key, name: p.name }
      cards.forEach((c) => c.setAttribute("aria-pressed", String(c === b)))
      paintQuote(p.key, p.name, false)
      flashQuote()
    })
    cards.push(b)
    ;(p.tier === "lab" ? pgridLab : pgrid).appendChild(b)
  }
  // Fall back to the first persona so the strip is never blank on first paint.
  if (!selectedPersona && personas[0]) {
    selectedPersona = { key: personas[0].key, name: personas[0].name }
  }
  restoreQuote()
}

// animationend bubbles: the .pqtxt fade would otherwise cancel the flash 180ms in.
pquote.addEventListener("animationend", (e) => {
  if (e.target === pquote && e.animationName === "pqflash") pquote.classList.remove("fire")
})

// --- tabs ------------------------------------------------------------------------

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs button"))
const panes = Array.from(document.querySelectorAll<HTMLElement>(".pane"))

function selectTab(key: string, focus = false): void {
  for (const b of tabButtons) {
    const on = b.dataset.tab === key
    b.setAttribute("aria-selected", String(on))
    b.tabIndex = on ? 0 : -1
    if (on && focus) b.focus()
  }
  for (const p of panes) p.classList.toggle("on", p.dataset.pane === key)
  history.replaceState(null, "", `#${key}`)
}

tabButtons.forEach((b, i) => {
  b.addEventListener("click", () => selectTab(b.dataset.tab ?? ""))
  b.addEventListener("keydown", (e) => {
    const fwd = e.key === "ArrowDown" || e.key === "ArrowRight"
    if (!fwd && e.key !== "ArrowUp" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const step = fwd ? 1 : tabButtons.length - 1
    const next = tabButtons[(i + step) % tabButtons.length]
    selectTab(next.dataset.tab ?? "", true)
  })
})

const initialTab = location.hash.slice(1)
if (tabButtons.some((b) => b.dataset.tab === initialTab)) selectTab(initialTab)

// --- wiring ----------------------------------------------------------------------

sens.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) =>
  b.addEventListener("click", () => {
    const level = b.dataset.level as SensitivityLevel
    renderSensitivity(level)
    void saveSettings({ tauOk: SENSITIVITY_PRESETS[level] })
  }),
)

quietSw.addEventListener("click", () => {
  const on = !isChecked(quietSw)
  setChecked(quietSw, on)
  quietStart.disabled = quietEnd.disabled = !on
  void saveSettings({ quietHours: { enabled: on, start: quietStart.value, end: quietEnd.value } })
})
const saveQuiet = (): void =>
  void saveSettings({ quietHours: { enabled: isChecked(quietSw), start: quietStart.value, end: quietEnd.value } })
quietStart.addEventListener("change", saveQuiet)
quietEnd.addEventListener("change", saveQuiet)

localPdfSw.addEventListener("click", () => {
  const on = !isChecked(localPdfSw)
  setChecked(localPdfSw, on)
  void saveSettings({ observeLocalPdfs: on })
})

restoreSw.addEventListener("click", () => {
  const on = !isChecked(restoreSw)
  setChecked(restoreSw, on)
  void saveSettings({ sessionAutoContinue: on })
})

// --- 사이트 목록 (감시 제외 / 항상 OK) ---------------------------------------------

function renderDomainLists(lists: DomainLists): void {
  blockList.value = lists.block.join("\n")
  allowList.value = lists.allow.join("\n")
  blockCount.textContent = String(lists.block.length)
  allowCount.textContent = String(lists.allow.length)
}

let siteResultTimer: ReturnType<typeof setTimeout> | undefined
async function saveDomainLists(): Promise<void> {
  const lines = (value: string): string[] => value.split("\n").map((s) => s.trim()).filter(Boolean)
  const res = (await send({
    type: "set-domain-lists",
    lists: { block: lines(blockList.value), allow: lines(allowList.value) },
  })) as { lists: DomainLists; rejected: string[] } | undefined
  if (!res) return
  renderDomainLists(res.lists) // reflect what was actually saved (scheme/path stripped, 중복 제거)
  clearTimeout(siteResultTimer)
  if (res.rejected.length > 0) {
    siteResult.className = "hint err"
    siteResult.textContent = `저장됨 — 호스트 형식이 아니어서 무시함: ${res.rejected.join(", ")}`
  } else {
    siteResult.className = "hint ok"
    siteResult.textContent = "저장됨 ✓"
    siteResultTimer = setTimeout(() => {
      siteResult.textContent = ""
    }, 1500)
  }
}
blockList.addEventListener("change", () => void saveDomainLists())
allowList.addEventListener("change", () => void saveDomainLists())

// --- AI 판정 (연결된 제공자 · 모델 지정 · 사용량) --------------------------------

const TIERS: readonly TierName[] = ["tier1", "tier2"]
const TIER_LABEL: Record<TierName, string> = { tier1: "Tier 1", tier2: "Tier 2" }

interface RouteDraft {
  provider: ProviderId
  model: string
  custom: boolean
}
interface ChipState {
  kind: "unknown" | "ok" | "err" | "testing"
  chip: string
  text: string
}

let judge: JudgeView | null = null
const draft: Record<TierName, RouteDraft> = {
  tier1: { provider: "ollama", model: "", custom: false },
  tier2: { provider: "ollama", model: "", custom: false },
}
const chips: Record<TierName, ChipState> = { tier1: staleChip(), tier2: staleChip() }
let aiPreference = true
let runtimeHealth: ProviderHealthSnapshot = { tier1: null, tier2: null }
let addOpenFor: ProviderId | null = null
let connectOpen = false
let usageDays = 1

function staleChip(): ChipState {
  return { kind: "unknown", chip: "– 테스트", text: "이 라우팅으로 실제 호출을 확인합니다" }
}

function profileOf(id: ProviderId): (typeof PROVIDER_PROFILES)[number] {
  const profile = PROVIDER_PROFILES.find((p) => p.id === id)
  if (!profile) throw new Error(`unknown provider: ${id}`)
  return profile
}

function presetsFor(id: ProviderId, tier: TierName): readonly string[] {
  const profile = profileOf(id)
  return tier === "tier1" ? profile.tier1Presets : profile.tier2Presets
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text) as HTMLButtonElement
  b.type = "button"
  b.addEventListener("click", onClick)
  return b
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtDate(ts: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Saved routes arrived (init/save/disconnect) — rebuild the drafts from them. */
function applyJudge(view: JudgeView): void {
  judge = view
  for (const tier of TIERS) {
    const route = view.routes[tier]
    draft[tier] = {
      provider: route.provider,
      model: route.model,
      custom: !presetsFor(route.provider, tier).includes(route.model),
    }
    chips[tier] = staleChip()
  }
  renderJudge()
}

/** Account change (connect/key add/remove) — adopt automatic saved-route changes only
 *  when that tier's draft was untouched, and otherwise preserve the user's draft. */
function applyAccounts(view: JudgeView): void {
  const previous = judge
  if (previous) {
    for (const tier of TIERS) {
      const oldRoute = previous.routes[tier]
      const d = draft[tier]
      const draftWasUntouched = d.provider === oldRoute.provider && d.model === oldRoute.model
      const route = view.routes[tier]
      if (draftWasUntouched && (route.provider !== oldRoute.provider || route.model !== oldRoute.model)) {
        draft[tier] = {
          provider: route.provider,
          model: route.model,
          custom: !presetsFor(route.provider, tier).includes(route.model),
        }
      }
    }
  }
  judge = view
  for (const tier of TIERS) chips[tier] = staleChip()
  renderJudge()
}

function renderJudge(): void {
  renderProviderBlocks()
  renderConnect()
  renderRoutes()
}

function renderProviderBlocks(): void {
  if (!judge) return
  ajProviders.textContent = ""
  for (const profile of PROVIDER_PROFILES) {
    const keyList = judge.accounts[profile.id]
    if (!keyList) continue // not connected
    const block = el("div", "pblock")

    const head = el("div", "phead")
    head.appendChild(el("span", "pname", profile.label))
    if (profile.id === "ollama") head.appendChild(el("span", "pbadge", "기본"))
    head.appendChild(el("span", "grow"))
    if (profile.id !== "ollama") {
      head.appendChild(
        button("punlink", "연결 해제", () => {
          if (!confirm(`${profile.label} 연결을 해제할까요? 등록된 키도 함께 삭제됩니다.`)) return
          void send({ type: "disconnect-provider", provider: profile.id }).then((raw) =>
            applyJudge(raw as JudgeView),
          )
        }),
      )
    }
    block.appendChild(head)
    block.appendChild(el("p", "pnote", profile.note))

    if (keyList.length === 0) {
      block.appendChild(el("div", "kempty", "등록된 키가 없습니다 — 키를 추가해야 라우팅에 쓸 수 있어요."))
    }
    keyList.forEach((key, index) => {
      const row = el("div", "krow")
      const meta = el("div", "kmeta")
      meta.appendChild(el("span", "kn", key.name || `키 ${index + 1}`))
      meta.appendChild(el("span", "kv", key.masked))
      row.appendChild(meta)
      row.appendChild(el("span", "kdate", fmtDate(key.addedAt)))
      const del = button("kdel", "✕", () => {
        void send({ type: "remove-provider-key", provider: profile.id, keyId: key.id }).then(
          (view) => applyAccounts(view as JudgeView),
        )
      })
      del.setAttribute("aria-label", `${key.name || `키 ${index + 1}`} 삭제`)
      row.appendChild(del)
      block.appendChild(row)
    })

    if (addOpenFor === profile.id) {
      block.appendChild(buildKeyForm(profile.id, profile.keyHint, keyList.length))
    } else {
      block.appendChild(
        button("kadd", "＋ 키 추가", () => {
          addOpenFor = profile.id
          connectOpen = false
          renderJudge()
        }),
      )
    }
    if (keyList.length >= 2) {
      block.appendChild(
        el("p", "krot", `키 ${keyList.length}개 — 한도 초과(429) 시 자동으로 다음 키로 로테이션합니다.`),
      )
    }
    ajProviders.appendChild(block)
  }
}

function buildKeyForm(provider: ProviderId, keyHint: string, existingKeyCount: number): HTMLElement {
  const form = el("div", "kform")
  const name = document.createElement("input")
  name.type = "text"
  name.className = "f-name"
  const defaultName = defaultProviderKeyName(provider, existingKeyCount)
  name.placeholder = defaultName
  name.value = defaultName
  const key = document.createElement("input")
  key.type = "password"
  key.className = "f-key"
  key.placeholder = keyHint
  key.autocomplete = "off"
  const commit = (): void => {
    if (!key.value.trim()) {
      key.focus()
      return
    }
    void send({ type: "add-provider-key", provider, name: name.value, value: key.value }).then(
      (view) => {
        addOpenFor = null
        applyAccounts(view as JudgeView)
      },
    )
  }
  key.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit()
  })
  form.append(
    name,
    key,
    button("btn primary", "추가", commit),
    button("btn", "취소", () => {
      addOpenFor = null
      renderJudge()
    }),
  )
  queueMicrotask(() => name.focus())
  return form
}

function renderConnect(): void {
  if (!judge) return
  ajConnect.textContent = ""
  const remaining = PROVIDER_PROFILES.filter((p) => !judge?.accounts[p.id])
  if (remaining.length === 0) return
  if (!connectOpen) {
    ajConnect.appendChild(
      button("connectbtn", "＋ 제공자 연결", () => {
        connectOpen = true
        addOpenFor = null
        renderJudge()
      }),
    )
    return
  }
  const row = el("div", "connectrow")
  const select = document.createElement("select")
  select.setAttribute("aria-label", "연결할 제공자")
  for (const p of remaining) {
    const option = document.createElement("option")
    option.value = p.id
    option.textContent = p.label
    select.appendChild(option)
  }
  row.append(
    select,
    button("btn primary", "연결", () => {
      const provider = select.value as ProviderId
      void send({ type: "connect-provider", provider }).then((view) => {
        connectOpen = false
        addOpenFor = provider // 연결 직후 바로 키 입력으로
        applyAccounts(view as JudgeView)
      })
    }),
    button("btn", "취소", () => {
      connectOpen = false
      renderJudge()
    }),
  )
  ajConnect.appendChild(row)
}

function renderRoutes(): void {
  if (!judge) return
  for (const tier of TIERS) {
    const ctl = document.querySelector<HTMLElement>(`.mctl[data-tier="${tier}"]`)
    const prov = ctl?.querySelector<HTMLSelectElement>(".prov")
    const model = ctl?.querySelector<HTMLSelectElement>(".model")
    const input = ctl?.querySelector<HTMLInputElement>(".modelinput")
    const back = ctl?.querySelector<HTMLButtonElement>(".backbtn")
    if (!prov || !model || !input || !back) continue
    const d = draft[tier]

    prov.textContent = ""
    for (const profile of PROVIDER_PROFILES) {
      if (!judge.accounts[profile.id]) continue
      const option = document.createElement("option")
      option.value = profile.id
      option.textContent = profile.label
      prov.appendChild(option)
    }
    prov.value = d.provider
    prov.onchange = () => {
      d.provider = prov.value as ProviderId
      d.custom = false
      d.model = presetsFor(d.provider, tier)[0]
      chips[tier] = staleChip()
      renderRoutes()
    }

    model.textContent = ""
    const presets = presetsFor(d.provider, tier)
    presets.forEach((m, i) => {
      const option = document.createElement("option")
      option.value = m
      option.textContent = i === 0 ? `${m} (기본)` : m
      model.appendChild(option)
    })
    const custom = document.createElement("option")
    custom.value = "__custom"
    custom.textContent = "직접 입력…"
    model.appendChild(custom)

    model.classList.toggle("hidden", d.custom)
    input.classList.toggle("hidden", !d.custom)
    back.classList.toggle("hidden", !d.custom)
    if (d.custom) input.value = d.model
    else model.value = presets.includes(d.model) ? d.model : presets[0]

    model.onchange = () => {
      if (model.value === "__custom") {
        d.custom = true
        d.model = ""
        renderRoutes()
        input.focus()
      } else {
        d.model = model.value
        chips[tier] = staleChip()
        renderChip(tier)
        renderAiControls()
      }
    }
    input.oninput = () => {
      d.model = input.value.trim()
      if (chips[tier].kind !== "unknown") {
        chips[tier] = staleChip()
        renderChip(tier)
      }
      renderAiControls()
    }
    back.onclick = () => {
      d.custom = false
      d.model = presetsFor(d.provider, tier)[0]
      chips[tier] = staleChip()
      renderRoutes()
    }

    renderChip(tier)
  }
  renderAiControls()
}

function appendAiAlert(text: string, error: boolean): void {
  ajAlerts.appendChild(el("div", `ai-alert${error ? " err" : ""}`, text))
}

function renderAiControls(): void {
  if (!judge) return
  const complete = isAiConfigComplete(draft, judge.accounts)
  const active = effectiveAiEnabled(aiPreference, draft, judge.accounts)
  ajSave.disabled = !complete
  ajSave.title = complete ? "" : "Tier 1과 Tier 2의 모델·키를 모두 설정해야 저장할 수 있어요."
  ajEnabled.disabled = !complete
  ajEnabled.setAttribute("aria-pressed", String(active))
  ajEnabled.classList.toggle("on", active)
  ajEnabled.textContent = active ? "AI 판정 켜짐" : "AI 판정 꺼짐"

  ajAlerts.textContent = ""
  if (!complete) {
    appendAiAlert(INCOMPLETE_COPY, true)
    const missing = incompleteTiers(draft, judge.accounts).map((tier) => TIER_LABEL[tier]).join(" · ")
    appendAiAlert(`${missing}의 모델과 API 키를 확인해 주세요.`, true)
  } else if (!aiPreference) {
    appendAiAlert(DISABLED_COPY, false)
  }

  for (const tier of TIERS) {
    if (chips[tier].kind === "err") {
      appendAiAlert(`${TIER_LABEL[tier]} 테스트 오류 — ${chips[tier].text}`, true)
      continue
    }
    const health = runtimeHealth[tier]
    if (aiPreference && health && !health.ok) {
      appendAiAlert(`${TIER_LABEL[tier]} 실행 오류 — ${health.message}`, true)
    }
  }
}

function renderChip(tier: TierName): void {
  const chipEl = document.querySelector<HTMLButtonElement>(`.stchip[data-tier="${tier}"]`)
  if (!chipEl) return
  const state = chips[tier]
  chipEl.textContent = state.chip
  chipEl.className = `stchip${state.kind === "ok" ? " ok" : state.kind === "err" ? " err" : ""}`
  chipEl.title =
    state.kind === "testing" ? state.text : `${state.text} (눌러서 ${state.kind === "ok" ? "다시 " : ""}테스트)`
}

async function runRouteTest(tier: TierName): Promise<void> {
  if (chips[tier].kind === "testing") return
  const d = draft[tier]
  chips[tier] = { kind: "testing", chip: "… 확인 중", text: "확인 중 — 첫 호출은 느릴 수 있어요" }
  renderChip(tier)
  const result = (await send({
    type: "test-route",
    tier,
    provider: d.provider,
    model: d.model,
  })) as RouteTestResult | undefined
  if (result?.ok) {
    chips[tier] = { kind: "ok", chip: "✓ 방금 전", text: `정상 — ${result.detail}` }
    runtimeHealth[tier] = null
    if (ajResult.classList.contains("err")) {
      ajResult.className = "hint"
      ajResult.textContent = ""
    }
  } else {
    const detail = result?.detail ?? "응답 없음"
    chips[tier] = { kind: "err", chip: "✕ 오류", text: detail }
    // ✕ 원인은 툴팁만으론 발견성이 낮아 카드 하단 힌트에도 표시
    ajResult.className = "hint err"
    ajResult.textContent = `${TIER_LABEL[tier]} · ${profileOf(d.provider).label} — ${detail}`
  }
  renderChip(tier)
  renderAiControls()
}

for (const chipEl of document.querySelectorAll<HTMLButtonElement>(".stchip")) {
  chipEl.addEventListener("click", () => void runRouteTest(chipEl.dataset.tier as TierName))
}

ajSave.addEventListener("click", async () => {
  if (!judge || !isAiConfigComplete(draft, judge.accounts)) return
  const view = (await send({
    type: "set-routes",
    routes: {
      tier1: { provider: draft.tier1.provider, model: draft.tier1.model },
      tier2: { provider: draft.tier2.provider, model: draft.tier2.model },
    },
  })) as JudgeView
  applyJudge(view)
  const r = view.routes
  ajResult.className = "hint ok"
  ajResult.textContent = `저장됨 ✓ — Tier 1: ${profileOf(r.tier1.provider).label} · ${r.tier1.model} / Tier 2: ${profileOf(r.tier2.provider).label} · ${r.tier2.model}`
})

ajEnabled.addEventListener("click", async () => {
  if (!judge || !isAiConfigComplete(draft, judge.accounts)) return
  aiPreference = !aiPreference
  await saveSettings({ aiJudgmentEnabled: aiPreference })
  if (!aiPreference) runtimeHealth = { tier1: null, tier2: null }
  renderAiControls()
})

$<HTMLButtonElement>("openSiteSettings").addEventListener("click", () => {
  selectTab("sites", true)
  blockList.focus()
})

async function loadUsage(): Promise<void> {
  const res = (await send({ type: "get-usage", days: usageDays })) as { rows?: UsageRow[] } | undefined
  const rows = res?.rows ?? []
  ajUsage.textContent = ""
  if (rows.length === 0) {
    const tr = el("tr")
    const td = el("td", "uempty", "아직 기록된 호출이 없습니다.")
    td.setAttribute("colspan", "4")
    tr.appendChild(td)
    ajUsage.appendChild(tr)
  }
  for (const row of rows) {
    const tr = el("tr")
    const name = el("td")
    name.appendChild(el("span", "um", row.model))
    name.appendChild(
      el("span", "sub", PROVIDER_PROFILES.find((p) => p.id === row.provider)?.label ?? row.provider),
    )
    tr.append(
      name,
      el("td", undefined, fmtTokens(row.calls)),
      el("td", undefined, fmtTokens(row.tokensIn)),
      el("td", undefined, fmtTokens(row.tokensOut)),
    )
    ajUsage.appendChild(tr)
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>(".ubtn")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.days) === usageDays))
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>(".ubtn")) {
  b.addEventListener("click", () => {
    usageDays = Number(b.dataset.days) || 1
    void loadUsage()
  })
}

const exportClick = (btn: HTMLButtonElement, type: string, label: string) =>
  btn.addEventListener("click", async () => {
    const r = (await send({ type })) as { ok: boolean } | undefined
    btn.textContent = r?.ok ? "저장됨 ✓" : "실패"
    setTimeout(() => (btn.textContent = label), 1200)
  })
exportClick(exportLog, "export-log", "디버그 로그 파일")
exportClick(exportEvents, "export-events", "이벤트 JSON")

$<HTMLButtonElement>("openReplay").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("replay/replay.html") })
})

wipe.addEventListener("click", async () => {
  if (!confirm("모든 활동 데이터(게이지·이력·학습·이벤트·나깅)를 삭제할까요? 목표·키·말투는 유지됩니다.")) return
  await send({ type: "delete-all-data" })
  wipe.textContent = "삭제됨 ✓"
  setTimeout(() => (wipe.textContent = "삭제"), 1500)
})

// Footer — "Contact Us" copies both developer addresses in <addr>, <addr> form.
const CONTACT_EMAILS = ["kimdenya1@gmail.com", "enu3379@gmail.com"]
const contactToast = $<HTMLElement>("contactToast")
let contactToastTimer: ReturnType<typeof setTimeout> | undefined

const showContactToast = (msg: string) => {
  contactToast.textContent = msg
  contactToast.classList.add("on")
  clearTimeout(contactToastTimer)
  contactToastTimer = setTimeout(() => contactToast.classList.remove("on"), 1800)
}

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API can reject when the page is not focused — fall back to execCommand.
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  }
}

$<HTMLButtonElement>("contactUs").addEventListener("click", async () => {
  const text = CONTACT_EMAILS.map((e) => `<${e}>`).join(", ")
  showContactToast((await copyText(text)) ? "이메일 주소가 복사되었습니다" : "이메일 주소를 복사하지 못했습니다")
})

void init()

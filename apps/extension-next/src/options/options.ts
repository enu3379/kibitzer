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
  STATUS_COPY,
  aiStatus,
  aiStatusTone,
  isAiConfigComplete,
  pendingSub,
  providerIsRouted,
  providerLockCopy,
  routedTiers,
  tierGap,
  tierGapCopy,
  type ProviderLockKind,
} from "./aiTabState.ts"

import { buildProviderWarn } from "../lib/providerHealthView.ts"
import type { ProviderHealthSnapshot } from "../lib/providerHealth.ts"

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
interface CandidateKeyTestResult {
  ok: boolean
  tiers: Record<TierName, RouteTestResult>
  view: JudgeView | null
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
const ajState = $<HTMLElement>("ajState")
const ajStateText = $<HTMLElement>("ajStateText")
const ajStateSub = $<HTMLElement>("ajStateSub")
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
  if (key === "ai") void refreshProviderHealth()
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
const routeTestTokens: Record<TierName, number> = { tier1: 0, tier2: 0 }
let aiPreference = true
let runtimeHealth: ProviderHealthSnapshot = { tier1: null, tier2: null }
let addOpenFor: ProviderId | null = null
let connectOpen = false
let usageDays = 1
/** A provider control refused because AI judging is using it. Rendered under the control
 *  that refused, not in the runtime alert stack — it is a precondition, not a failure. */
let providerLock: { provider: ProviderId; kind: ProviderLockKind } | null = null
/** The only genuine failure the tab can produce on its own: the preference write failed. */
let preferenceSaveError: string | null = null
/** Tiers with an alert-stack retest in flight, and the outcome of the last one that
 *  failed — a repeat failure changes nothing in the stored record, so the tab has to
 *  report it itself. Dropped as soon as that tier stops having a fact line. */
const retestInFlight = new Set<TierName>()
let retestFailure: { tier: TierName; detail: string } | null = null

/** Dismiss both transient notices. The provider lock lives inside the provider block,
 *  which every caller here leaves alone, so the banner has to be taken out by hand —
 *  otherwise the refusal outlives the state that justified it. Detaching just the banner
 *  rather than re-rendering the block matters: a rebuild would wipe an open key form and
 *  steal focus mid-typing. */
function dismissAiNotices(): void {
  providerLock = null
  preferenceSaveError = null
  for (const banner of ajProviders.querySelectorAll(".route-banner")) banner.remove()
}

function staleChip(): ChipState {
  return { kind: "unknown", chip: "– 테스트", text: "이 라우팅으로 실제 호출을 확인합니다" }
}

function routeTestFingerprint(tier: TierName): string {
  const route = draft[tier]
  const keyIds = (judge?.accounts[route.provider] ?? []).map((key) => key.id)
  return JSON.stringify([route.provider, route.model, keyIds])
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
  providerLock = null
  preferenceSaveError = null
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
  providerLock = null
  preferenceSaveError = null
  for (const tier of TIERS) chips[tier] = staleChip()
  renderJudge()
}

function renderJudge(): void {
  renderProviderBlocks()
  renderConnect()
  renderRoutes()
}

/** The tiers a refusal is protecting. The guards accept either the draft or the saved
 *  route as "in use" (an unsaved reroute must not open a hole), so the sentence names the
 *  union of both — anything narrower could list no tier at all. */
function lockedTierLabels(provider: ProviderId): string[] {
  const tiers = new Set([
    ...routedTiers(provider, draft),
    ...(judge ? routedTiers(provider, judge.routes) : []),
  ])
  return TIERS.filter((tier) => tiers.has(tier)).map((tier) => TIER_LABEL[tier])
}

function renderProviderBlocks(): void {
  if (!judge) return
  const savedRoutes = judge.routes
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
          const usedByDraftOrSaved =
            providerIsRouted(profile.id, draft) || providerIsRouted(profile.id, savedRoutes)
          if (aiPreference && usedByDraftOrSaved) {
            providerLock = { provider: profile.id, kind: "disconnect" }
            renderProviderBlocks()
            return
          }
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
        const usedByDraftOrSaved =
          providerIsRouted(profile.id, draft) || providerIsRouted(profile.id, savedRoutes)
        const isLastRoutedKey = keyList.length === 1 && usedByDraftOrSaved
        if (aiPreference && isLastRoutedKey) {
          providerLock = { provider: profile.id, kind: "last-key" }
          renderProviderBlocks()
          return
        }
        if (!confirm(`${key.name || `키 ${index + 1}`}을 삭제할까요?`)) return
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
    if (providerLock?.provider === profile.id) {
      block.appendChild(
        el("div", "route-banner", providerLockCopy(providerLock.kind, lockedTierLabels(profile.id))),
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
  const status = el("p", "ktest")
  const add = button("btn primary", "추가", () => void commit())
  const cancel = button("btn", "취소", () => {
    addOpenFor = null
    renderJudge()
  })
  let testing = false
  const modelsForCandidate = (): Record<TierName, string> => ({
    tier1: draft.tier1.provider === provider
      ? draft.tier1.model
      : presetsFor(provider, "tier1")[0],
    tier2: draft.tier2.provider === provider
      ? draft.tier2.model
      : presetsFor(provider, "tier2")[0],
  })
  const commit = async (): Promise<void> => {
    if (testing) return
    if (!key.value.trim()) {
      key.focus()
      return
    }
    testing = true
    add.disabled = cancel.disabled = name.disabled = key.disabled = true
    add.textContent = "Tier 1·2 확인 중…"
    status.className = "ktest"
    status.textContent = "새 키만 사용해 두 모델을 확인하고 있어요. 첫 호출은 느릴 수 있습니다."
    const models = modelsForCandidate()
    try {
      const tested = (await send({
        type: "test-and-add-provider-key",
        provider,
        name: name.value,
        value: key.value,
        models,
      })) as CandidateKeyTestResult
      if (!tested.ok) {
        const failures = TIERS
          .filter((tier) => !tested.tiers[tier].ok)
          .map((tier) => `${TIER_LABEL[tier]} — ${tested.tiers[tier].detail}`)
        status.className = "ktest err"
        status.textContent = `${failures.join(" / ")} · 키와 모델을 다시 확인해 주세요.`
        return
      }
      const view = tested.view
      if (!view) throw new Error("validated key was not saved")
      addOpenFor = null
      applyAccounts(view)
      for (const tier of TIERS) {
        if (draft[tier].provider !== provider || draft[tier].model !== models[tier]) continue
        chips[tier] = {
          kind: "ok",
          chip: "✓ 방금 전",
          text: `정상 — ${tested.tiers[tier].detail}`,
        }
        renderChip(tier)
      }
      renderAiControls()
    } catch {
      status.className = "ktest err"
      status.textContent = "테스트 요청에 실패했습니다. 잠시 후 다시 시도해 주세요."
    } finally {
      testing = false
      add.disabled = cancel.disabled = name.disabled = key.disabled = false
      add.textContent = "추가"
      if (addOpenFor === provider) key.focus()
    }
  }
  key.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void commit()
  })
  form.append(name, key, add, cancel, status)
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
      dismissAiNotices()
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
      dismissAiNotices()
      if (model.value === "__custom") {
        d.custom = true
        d.model = ""
        chips[tier] = staleChip()
        renderRoutes()
        input.focus()
      } else {
        d.model = model.value
        chips[tier] = staleChip()
        renderTierState(tier)
        renderAiControls()
      }
    }
    input.oninput = () => {
      dismissAiNotices()
      d.model = input.value.trim()
      chips[tier] = staleChip()
      renderTierState(tier)
      renderAiControls()
    }
    back.onclick = () => {
      dismissAiNotices()
      d.custom = false
      d.model = presetsFor(d.provider, tier)[0]
      chips[tier] = staleChip()
      renderRoutes()
    }

    renderTierState(tier)
  }
  renderAiControls()
}

/** Status line + runtime alert stack + save button. Everything tier-local lives in
 *  renderTierState instead, next to the control that fixes it. */
function renderAiControls(): void {
  if (!judge) return
  // The save button is about the edit in progress, so it reads the draft.
  const draftComplete = isAiConfigComplete(draft, judge.accounts)
  const routeTestFailed = TIERS.some((tier) => chips[tier].kind === "err")
  ajSave.disabled = !draftComplete || routeTestFailed
  ajSave.title = !draftComplete
    ? "Tier 1과 Tier 2의 모델·키를 모두 설정해야 저장할 수 있어요."
    : routeTestFailed
      ? "오류가 난 Tier를 수정하거나 다시 테스트해 정상 응답을 확인해 주세요."
      : ""

  // The status line reports what the worker is running, so it reads the SAVED routes —
  // tier12 gates on those. Reading the draft would flip the line to "켜짐" the moment a
  // model name is typed, before 저장 has told the worker anything.
  const status = aiStatus(aiPreference, judge.routes, judge.accounts)
  // Runtime health only — a manual test result belongs to its tier row. Reuses the
  // popup's model so both surfaces name the same failure the same way and agree on
  // what it costs the user.
  const warn = aiPreference
    ? buildProviderWarn(runtimeHealth, routeKeyless(), Date.now())
    : { facts: [], consequence: null }
  // Derived from the drawn lines, not the raw records: an expired record produces no
  // fact, and must not colour the line red over an empty stack.
  const level = warn.facts.some((fact) => fact.tone === "red")
    ? "red"
    : warn.facts.length > 0
      ? "amber"
      : null

  const copy = STATUS_COPY[status]
  const sub = status === "pending" ? pendingSub(draftComplete) : copy.sub
  ajState.className = `aistate ${aiStatusTone(status, level)}`
  // #ajState is a live region, and renderAiControls runs on every keystroke in the custom
  // model field — writing an identical string still counts as a mutation and would make a
  // screen reader re-announce the status on every character.
  if (ajStateText.textContent !== copy.text) ajStateText.textContent = copy.text
  if (ajStateSub.textContent !== (sub ?? "")) ajStateSub.textContent = sub ?? ""
  ajStateSub.classList.toggle("hidden", sub == null)

  // The toggle carries the preference alone, so it is never disabled: preferring AI
  // with an unfinished setup is a legal state (`pending`), and an ON preference must
  // always be switchable back OFF.
  ajEnabled.setAttribute("aria-checked", String(aiPreference))

  ajAlerts.textContent = ""
  if (preferenceSaveError) {
    ajAlerts.appendChild(el("div", "ai-alert err", preferenceSaveError))
  }
  warn.facts.forEach((fact, index) => {
    const alert = el("div", `ai-alert${fact.tone === "red" ? " err" : ""}`)
    const msg = el("div", "msg")
    msg.appendChild(el("span", undefined, fact.text))
    // One consequence per snapshot: it describes the combined state, so it hangs off
    // the most severe (last) fact rather than repeating on every line.
    if (index === warn.facts.length - 1 && warn.consequence) {
      msg.appendChild(el("span", "conseq", warn.consequence))
    }
    if (retestFailure?.tier === fact.tier) {
      msg.appendChild(el("span", "conseq", `다시 테스트: 여전히 실패 — ${retestFailure.detail}`))
    }
    alert.appendChild(msg)
    const retest = el("button", "btn", "다시 테스트") as HTMLButtonElement
    retest.type = "button"
    retest.addEventListener("click", () => void retestSavedRoute(fact.tier, retest))
    alert.appendChild(retest)
    ajAlerts.appendChild(alert)
  })
}

/** Which tiers the health model should treat as keyless — the saved route's provider has
 *  no key. "both" is keyless too (no model AND no key), so this cannot test for "key". */
function routeKeyless(): { tier1: boolean; tier2: boolean } {
  const of = (tier: TierName): boolean => {
    if (!judge) return false
    const gap = tierGap(tier, judge.routes, judge.accounts)
    return gap === "key" || gap === "both"
  }
  return { tier1: of("tier1"), tier2: of("tier2") }
}

/** Everything that belongs to one tier's row: the test chip and the inline line under it
 *  (what the tier is still missing, or why its last manual test failed). */
function renderTierState(tier: TierName): void {
  renderChip(tier)
  const gapEl = document.querySelector<HTMLElement>(`.mgap[data-tier="${tier}"]`)
  if (!gapEl || !judge) return
  const chip = chips[tier]
  const gap = tierGap(tier, draft, judge.accounts)
  gapEl.textContent = ""

  // A missing model or key outranks a failed test: the test cannot pass until the gap is
  // filled (a keyless route fails with "키 없음"), and only the gap line offers the fix.
  if (gap === null) {
    if (chip.kind !== "err") {
      gapEl.className = "mgap hidden"
      return
    }
    gapEl.className = "mgap err"
    gapEl.appendChild(el("span", undefined, `테스트 실패 — ${chip.text}`))
    gapEl.appendChild(button("mgap-act", "다시 테스트", () => void runRouteTest(tier)))
    return
  }
  gapEl.className = "mgap"
  gapEl.appendChild(el("span", undefined, tierGapCopy(gap, profileOf(draft[tier].provider).label)))
  if (gap !== "model") {
    // Nothing to connect from here when the provider is already connected but keyless —
    // "＋ 키 추가" lives in that provider's block, so send the user there.
    gapEl.appendChild(button("mgap-act", "키 연결", () => {
      const provider = draft[tier].provider
      if (judge?.accounts[provider]) addOpenFor = provider
      else connectOpen = true
      renderJudge()
      ajProviders.scrollIntoView({ block: "nearest" })
    }))
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
  const token = ++routeTestTokens[tier]
  const fingerprint = routeTestFingerprint(tier)
  chips[tier] = { kind: "testing", chip: "… 확인 중", text: "확인 중 — 첫 호출은 느릴 수 있어요" }
  renderTierState(tier)
  let result: RouteTestResult | undefined
  try {
    result = (await send({
      type: "test-route",
      tier,
      provider: d.provider,
      model: d.model,
    })) as RouteTestResult | undefined
  } catch {
    result = { ok: false, detail: "테스트 요청에 실패했습니다. 잠시 후 다시 시도해 주세요." }
  }
  if (token !== routeTestTokens[tier] || fingerprint !== routeTestFingerprint(tier)) return
  if (result?.ok) {
    chips[tier] = { kind: "ok", chip: "✓ 방금 전", text: `정상 — ${result.detail}` }
    // The worker drops the stored failure itself when the tested route is the saved one
    // (an unsaved draft proves nothing about the route that failed). Re-read rather than
    // clearing locally, or the alert would come back on the next refresh.
    void refreshProviderHealth()
  } else {
    // The failure text goes on the tier's own row (renderTierState) — it used to be
    // repeated in the chip tooltip, the alert stack and this hint at the same time.
    chips[tier] = { kind: "err", chip: "✕ 오류", text: result?.detail ?? "응답 없음" }
  }
  renderTierState(tier)
  renderAiControls()
}

/** The alert stack describes a failure of the SAVED route, so its retest must call that
 *  route and not the draft — otherwise a passing draft would clear an alert for a route
 *  that is still broken. Leaves the tier's chip alone: the chip reports the draft.
 *
 *  If the saved route changes while the call is in flight, the worker compares the tested
 *  route against the new saved one and declines to clear — the alert stays, which is the
 *  safe direction. */
async function retestSavedRoute(tier: TierName, trigger: HTMLButtonElement): Promise<void> {
  // The stack is rebuilt on every render, so a fresh enabled button can appear under a
  // call that is still running: guard on the tier, not on this element.
  if (!judge || retestInFlight.has(tier)) return
  const route = judge.routes[tier]
  retestInFlight.add(tier)
  retestFailure = null
  trigger.disabled = true
  trigger.textContent = "확인 중…"
  let result: RouteTestResult | undefined
  try {
    result = (await send({
      type: "test-route", tier, provider: route.provider, model: route.model,
    })) as RouteTestResult | undefined
  } catch {
    result = { ok: false, detail: "테스트 요청에 실패했습니다. 잠시 후 다시 시도해 주세요." }
  } finally {
    retestInFlight.delete(tier)
    // The render below normally replaces this button, but every early return in
    // refreshProviderHealth skips it — without this the button stays "확인 중…" forever.
    trigger.disabled = false
    trigger.textContent = "다시 테스트"
  }
  // A retest that fails again leaves the stored record byte-identical, so the repainted
  // alert would be indistinguishable from the button doing nothing. Say so explicitly.
  if (result && !result.ok) retestFailure = { tier, detail: result.detail }
  await refreshProviderHealth()
  renderAiControls()
}

for (const chipEl of document.querySelectorAll<HTMLButtonElement>(".stchip")) {
  chipEl.addEventListener("click", () => void runRouteTest(chipEl.dataset.tier as TierName))
}

ajSave.addEventListener("click", async () => {
  if (
    !judge ||
    !isAiConfigComplete(draft, judge.accounts) ||
    TIERS.some((tier) => chips[tier].kind === "err")
  ) return
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
  if (!judge) return
  if (
    aiPreference &&
    !confirm("AI 판정을 끌까요?\n판정 품질이 낮아지고 훈수 메시지가 단순해져요.")
  ) return
  const nextPreference = !aiPreference
  // Turning ON commits the drafted routes so the preference and the routes it was made
  // against are stored together — but only when they are complete. An incomplete setup
  // enters `pending`: the preference is stored, the runtime stays local-only (tier12
  // resolves no provider), and it starts by itself once the last gap is filled. Saving
  // an incomplete route here would be rejected by setRoutes and strand the toggle.
  const commitRoutes = nextPreference && isAiConfigComplete(draft, judge.accounts)
  ajEnabled.disabled = true
  dismissAiNotices()
  try {
    let savedView: JudgeView | null = null
    if (commitRoutes) {
      savedView = (await send({
        type: "set-routes",
        routes: {
          tier1: { provider: draft.tier1.provider, model: draft.tier1.model },
          tier2: { provider: draft.tier2.provider, model: draft.tier2.model },
        },
      })) as JudgeView
      const accepted = TIERS.every((tier) =>
        savedView?.routes[tier].provider === draft[tier].provider &&
        savedView?.routes[tier].model === draft[tier].model
      )
      if (!accepted) throw new Error("route save rejected")
    }
    await saveSettings({ aiJudgmentEnabled: nextPreference })
    aiPreference = nextPreference
    // The mode edge invalidates the old failures (background clears the stored records
    // on the same edge) — keep this page's copy from outliving them.
    runtimeHealth = { tier1: null, tier2: null }
    if (savedView) applyJudge(savedView)
    else renderAiControls()
  } catch {
    preferenceSaveError = "AI 판정 설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."
    renderAiControls()
  } finally {
    ajEnabled.disabled = false
  }
})

/** The alert stack mirrors records the service worker writes while this page sits open,
 *  so a snapshot taken at load goes stale. Re-read it whenever the user comes back to the
 *  page or to this tab — the two moments where the stack is about to be looked at. */
async function refreshProviderHealth(): Promise<void> {
  let snapshot: ProviderHealthSnapshot | undefined
  try {
    snapshot = (await send({ type: "get-provider-health" })) as ProviderHealthSnapshot | undefined
  } catch {
    return // worker asleep or restarting — keep showing the last snapshot
  }
  if (!snapshot) return
  runtimeHealth = snapshot
  renderAiControls()
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshProviderHealth()
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

// 개발 빌드에만 존재하는 버튼 (일반 빌드에서는 build.mjs가 마크업을 잘라낸다).
document.getElementById("openReplay")?.addEventListener("click", () => {
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

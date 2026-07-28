// Options page: sensitivity, quiet hours, voice, persona, AI judge providers, and data
// controls. All state lives in the service worker; this page just reads/writes via
// messages — key values travel INTO the worker only, responses carry masked keys.

import { PROVIDER_PROFILES, type ProviderId, type TierName } from "../lib/providers.ts"

interface Settings {
  tauOk: number
  quietHours: { enabled: boolean; start: string; end: string }
  ttsEnabled: boolean
}
interface StateResponse {
  persona?: string
  personas?: Array<{ key: string; name: string }>
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

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const tau = $<HTMLInputElement>("tau")
const tauVal = $<HTMLElement>("tauVal")
const quietSw = $<HTMLButtonElement>("quietSw")
const quietStart = $<HTMLInputElement>("quietStart")
const quietEnd = $<HTMLInputElement>("quietEnd")
const ttsSw = $<HTMLButtonElement>("ttsSw")
const pgrid = $<HTMLElement>("pgrid")
const ajProviders = $<HTMLElement>("ajProviders")
const ajConnect = $<HTMLElement>("ajConnect")
const ajUsage = $<HTMLElement>("ajUsage")
const ajSave = $<HTMLButtonElement>("ajSave")
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

// --- init ------------------------------------------------------------------------

async function init(): Promise<void> {
  const settings = (await send({ type: "get-settings" })) as Settings
  tau.value = String(settings.tauOk)
  tauVal.textContent = settings.tauOk.toFixed(2)
  setChecked(quietSw, settings.quietHours.enabled)
  quietStart.value = settings.quietHours.start
  quietEnd.value = settings.quietHours.end
  quietStart.disabled = quietEnd.disabled = !settings.quietHours.enabled
  setChecked(ttsSw, settings.ttsEnabled)

  const state = (await send({ type: "get-state" })) as StateResponse
  if (state?.personas) {
    pgrid.innerHTML = ""
    for (const p of state.personas) {
      const b = document.createElement("button")
      b.className = "pcard"
      b.setAttribute("aria-pressed", String(p.key === state.persona))
      b.dataset.key = p.key
      b.innerHTML = `<span class="pn">${p.name}</span>`
      b.addEventListener("click", async () => {
        await send({ type: "set-persona", persona: p.key })
        pgrid.querySelectorAll<HTMLElement>(".pcard").forEach((c) =>
          c.setAttribute("aria-pressed", String(c === b)),
        )
      })
      pgrid.appendChild(b)
    }
  }
  applyJudge((await send({ type: "get-judge-settings" })) as JudgeView)
  await loadUsage()
}

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

tau.addEventListener("input", () => {
  tauVal.textContent = Number(tau.value).toFixed(2)
})
tau.addEventListener("change", () => {
  void saveSettings({ tauOk: Number(tau.value) })
})

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

ttsSw.addEventListener("click", () => {
  const on = !isChecked(ttsSw)
  setChecked(ttsSw, on)
  void saveSettings({ ttsEnabled: on })
})

// --- AI 판정 (연결된 제공자 · 판정 라우팅 · 사용량) --------------------------------

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

/** Account change (connect/key add/remove) — keep unsaved routing drafts, reset chips. */
function applyAccounts(view: JudgeView): void {
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
          void send({ type: "disconnect-provider", provider: profile.id }).then((view) =>
            applyJudge(view as JudgeView),
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
      block.appendChild(buildKeyForm(profile.id, profile.keyHint))
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

function buildKeyForm(provider: ProviderId, keyHint: string): HTMLElement {
  const form = el("div", "kform")
  const name = document.createElement("input")
  name.type = "text"
  name.className = "f-name"
  name.placeholder = "이름 (선택) — 예: 서브 계정"
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
      }
    }
    input.oninput = () => {
      d.model = input.value.trim()
      if (chips[tier].kind !== "unknown") {
        chips[tier] = staleChip()
        renderChip(tier)
      }
    }
    back.onclick = () => {
      d.custom = false
      d.model = presetsFor(d.provider, tier)[0]
      chips[tier] = staleChip()
      renderRoutes()
    }

    renderChip(tier)
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
}

for (const chipEl of document.querySelectorAll<HTMLButtonElement>(".stchip")) {
  chipEl.addEventListener("click", () => void runRouteTest(chipEl.dataset.tier as TierName))
}

ajSave.addEventListener("click", async () => {
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

void init()

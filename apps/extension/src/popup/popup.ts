import {
  ControllerType,
  CurrentPageProcessingStage,
  FeedbackKind,
  GoalInfo,
  HealthStatus,
  LatestObservation,
  PageLabel,
  PendingIntervention,
  PersonaSummary,
  SessionReport,
  SessionState,
  SessionStats,
  Settings,
  deleteAllActivityData,
  getCurrentSession,
  getHealthStatus,
  getCurrentPageState,
  getPersonas,
  getSessionReport,
  getSessionState,
  getSessionStats,
  getSettings,
  postFeedback,
  postObservationLabel,
  postSessionEnd,
  postSessionSnooze,
  putSettings,
} from "../lib/api"
import {
  ExplorationHistoryEntry,
  ExplorationResponseKind,
  ExplorationVerdict,
  loadExplorationHistory,
} from "../lib/history"
import type { GaugeShadowSnapshot } from "../lib/gaugeShadow"
import { providerFailureDiagnostics } from "../lib/providerFailureDiagnostics"
import { completeDashboardSnapshot } from "./dashboardSnapshot"
import type { DashboardSnapshot } from "./dashboardSnapshot"

const POLL_MS = 2000
const PROCESSING_POLL_MS = 500
const DEFAULT_OBSERVATION_SECONDS = 5
const TRACKING_PILLS: Record<SessionState["tracking"], { label: string; tone: string }> = {
  coldstart: { label: "워밍업", tone: "gray" },
  tracking: { label: "추적 중", tone: "green" },
  snoozed: { label: "스누즈 중", tone: "blue" },
  cooldown: { label: "쿨다운", tone: "amber" },
}

// Personas come from GET /personas (built-ins + ~/.kibitzer merges). Hints are
// UI copy the server does not carry; unknown/custom personas get no hint.
const PERSONA_HINTS: Record<string, string> = {
  dry_kibitzer: "영국식 무표정 반어",
  chungcheong: "말을 아끼는 함축 화법",
  kyoto: "칭찬으로 포장한 지적",
  quiet_coach: "수치심 없는 리다이렉트",
}
const FALLBACK_PERSONAS: PersonaSummary[] = [
  { key: "dry_kibitzer", name: "건조한 훈수꾼" },
  { key: "chungcheong", name: "느긋한 이웃" },
  { key: "kyoto", name: "교토식 안주인" },
  { key: "quiet_coach", name: "조용한 코치" },
]

const CONTROLLERS: { type: ControllerType; label: string; hint: string }[] = [
  { type: "alignment", label: "A안", hint: "EWMA" },
  { type: "streak", label: "B안", hint: "연속 이탈" },
]

const root = document.getElementById("root") as HTMLElement

// Dev diagnostics is a display preference of this popup, not server state —
// persisted in the extension page's localStorage (survives popup reopens).
const DEV_DIAGNOSTICS_KEY = "kibitzer.devDiagnostics"

// Last successfully rendered dashboard, so the popup still opens (read-only)
// while the local server is down. Cleared once the server says the session it
// captured is gone.
const LAST_SNAPSHOT_KEY = "kibitzer.lastSnapshot"

let editing = false
let summary: SessionStats | null = null
let settingsOpen = false
let reportOpen = false
let historyOpen = false
let pollTimer: number | undefined
let personaCache: PersonaSummary[] = FALLBACK_PERSONAS
let serverDown = false
// Which offline view is on screen; poll re-renders are skipped while it stays
// the same so typing in the goal input survives the 2s reconnect poll.
let offlineView: "setup" | "dashboard" | null = null
let devDiagnostics = false
let currentGoalBudgetMinutes: number | null = null
let pendingGoalText: string | null = null
try {
  devDiagnostics = localStorage.getItem(DEV_DIAGNOSTICS_KEY) === "1"
} catch {
  // localStorage unavailable — leave diagnostics off.
}

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  )
}

function saveSnapshot(snapshot: DashboardSnapshot): void {
  try {
    localStorage.setItem(LAST_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Best-effort — offline mode just falls back to the setup screen.
  }
}

function loadSnapshot(): DashboardSnapshot | null {
  try {
    const raw = localStorage.getItem(LAST_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DashboardSnapshot
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.state || typeof parsed.state.tracking !== "string") return null
    if (typeof parsed.goalText !== "string") return null
    if (!parsed.stats || typeof parsed.stats.session_id !== "string") return null
    return parsed
  } catch {
    return null
  }
}

function clearSnapshot(): void {
  try {
    localStorage.removeItem(LAST_SNAPSHOT_KEY)
  } catch {
    // ignore
  }
}

function schedulePoll(delayMs = POLL_MS): void {
  stopPoll()
  pollTimer = window.setTimeout(() => {
    void refresh()
  }, delayMs)
}

function stopPoll(): void {
  if (pollTimer) window.clearTimeout(pollTimer)
  pollTimer = undefined
}

function notifyBadge(): void {
  void chrome.runtime.sendMessage({ type: "kibitzer:refresh-badge" }).catch(() => undefined)
}

async function syncExplorationHistoryVerdict(
  observationId: string,
  verdict: "OK" | "DRIFT",
): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "kibitzer:update-history-verdict",
    observationId,
    verdict,
  }).catch(() => undefined)
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}시간 ${minutes % 60}분`
  return `${minutes}분`
}

function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return "–"
  return `${Math.round(ratio * 100)}%`
}

function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return "–"
  return score.toFixed(2)
}

function header(pillLabel: string, pillTone: string): string {
  return `
    <div class="header">
      <img src="../icons/icon-32.png" alt="" />
      <span class="name">Kibitzer</span>
      <span class="pill ${pillTone}">${esc(pillLabel)}</span>
    </div>`
}

interface ActiveTab {
  id: number
  url: string
  title: string
}

async function getActiveTab(): Promise<ActiveTab | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (tab?.id === undefined || !tab.url) return null
    return { id: tab.id, url: tab.url, title: tab.title ?? "" }
  } catch {
    return null
  }
}

type LocalPageProcessingStage = "tier0"

async function getLocalPageProcessingStage(activeTab: ActiveTab): Promise<LocalPageProcessingStage | null> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kibitzer:get-page-processing-stage",
      tabId: activeTab.id,
      url: activeTab.url,
    }) as { stage?: LocalPageProcessingStage | null } | undefined
    return response?.stage ?? null
  } catch {
    return null
  }
}

async function getGaugeShadowSnapshot(sessionId: string): Promise<GaugeShadowSnapshot | null> {
  if (!devDiagnostics) return null
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kibitzer:get-gauge-shadow",
    }) as { snapshot?: GaugeShadowSnapshot | null } | undefined
    const snapshot = response?.snapshot ?? null
    return snapshot?.sessionId === sessionId ? snapshot : null
  } catch {
    return null
  }
}

async function clearGaugeShadowSnapshot(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kibitzer:clear-gauge-shadow",
    }) as { ok?: boolean } | undefined
    return response?.ok === true
  } catch {
    return false
  }
}

async function refresh(): Promise<void> {
  if (editing || summary || settingsOpen || reportOpen || historyOpen) return
  const result = await getSessionState()
  if (result.kind === "unreachable") {
    handleUnreachable()
    return
  }
  // Reconnect: carry over anything typed into the offline goal input before
  // the online render replaces it.
  const typedGoal = serverDown
    ? (pendingGoalText ?? (document.getElementById("goal-input") as HTMLInputElement | null)?.value ?? "")
    : ""
  serverDown = false
  offlineView = null
  if (result.kind === "no_session") {
    clearSnapshot()
    stopPoll()
    currentGoalBudgetMinutes = null
    renderSetup(typedGoal)
    return
  }
  if (!result.state.has_goal) {
    clearSnapshot()
    stopPoll()
    currentGoalBudgetMinutes = null
    renderSetup(typedGoal)
    return
  }
  const activeTab = await getActiveTab()
  const [current, stats, health, pageState, localStage, settings, gaugeShadowSnapshot] = await Promise.all([
    getCurrentSession(),
    getSessionStats(),
    getHealthStatus(),
    activeTab === null ? Promise.resolve(null) : getCurrentPageState(activeTab.id, activeTab.url),
    activeTab === null ? Promise.resolve(null) : getLocalPageProcessingStage(activeTab),
    getSettings(),
    getGaugeShadowSnapshot(result.state.session_id),
  ])
  const serverStage = pageState?.state === "processing" ? pageState.stage ?? null : null
  const processingStage = serverStage ?? localStage
  const page = !processingStage && pageState?.state === "judged" ? pageState.observation ?? null : null
  const pageTitle = pageState?.title ?? activeTab?.title ?? null
  const pageHost = pageState?.url_host ?? (() => {
    try {
      return activeTab ? new URL(activeTab.url).hostname : null
    } catch {
      return null
    }
  })()
  const dashboard = completeDashboardSnapshot(result.state, current, stats)
  if (!dashboard) {
    handleUnreachable()
    return
  }
  const { snapshot } = dashboard
  currentGoalBudgetMinutes = dashboard.availableTimeMinutes
  saveSnapshot(snapshot)
  renderDashboard(
    snapshot.state,
    snapshot.goalText,
    snapshot.stats,
    health,
    page,
    false,
    settings?.dwell.observation_seconds ?? DEFAULT_OBSERVATION_SECONDS,
    processingStage,
    pageTitle,
    pageHost,
    gaugeShadowSnapshot,
  )
  schedulePoll(processingStage ? PROCESSING_POLL_MS : POLL_MS)
}

// Server-down handling (issue #11): the popup keeps rendering — a red banner
// on top, the last-seen dashboard (read-only) below, and the 2s poll keeps
// running so reconnecting is automatic.
function handleUnreachable(): void {
  editing = false
  settingsOpen = false
  reportOpen = false
  serverDown = true
  renderOffline()
  schedulePoll()
}

function offlineBannerHtml(hint: string): string {
  return `
    <div class="offline-banner">
      <p class="ob-title">서버 연결 안 됨 — 추적을 사용할 수 없어요</p>
      <p class="ob-hint">${esc(hint)}</p>
    </div>`
}

function renderOffline(): void {
  const snapshot = loadSnapshot()
  if (snapshot) {
    if (offlineView === "dashboard") return
    offlineView = "dashboard"
    renderDashboard(snapshot.state, snapshot.goalText, snapshot.stats, null, null, true)
    return
  }
  if (offlineView === "setup") return
  offlineView = "setup"
  const typed = pendingGoalText ?? (document.getElementById("goal-input") as HTMLInputElement | null)?.value ?? ""
  renderSetup(typed, true)
}

function renderSetup(currentGoal = "", offline = false): void {
  root.innerHTML = `
    ${header(offline ? "연결 안 됨" : "목표 없음", offline ? "red" : "amber")}
    ${offline ? offlineBannerHtml("서버가 켜지면 자동으로 다시 연결돼요.") : ""}
    <p class="label">오늘의 목표</p>
    <input id="goal-input" class="goal-input" type="text"
      placeholder="예: 핀란드 여행 일정 계획하기" value="${esc(currentGoal)}" />
    <p class="label">사용 가능 시간 (선택)</p>
    <input id="time-budget-input" class="goal-input" type="number" min="1" max="1440" step="1"
      placeholder="예: 120 (분)" value="${currentGoalBudgetMinutes ?? ""}" />
    <div class="btn-row">
      <button id="goal-submit" class="btn primary"${offline ? " disabled" : ""}>추적 시작</button>
      ${editing ? '<button id="goal-cancel" class="btn">취소</button>' : ""}
    </div>`

  const input = document.getElementById("goal-input") as HTMLInputElement
  const submit = document.getElementById("goal-submit") as HTMLButtonElement
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !serverDown) void submitGoal()
  })
  submit.addEventListener("click", () => {
    void submitGoal()
  })
  document.getElementById("goal-cancel")?.addEventListener("click", () => {
    editing = false
    settingsOpen = false
    historyOpen = false
    void refresh()
  })
}

function renderGoalPreparing(): void {
  stopPoll()
  root.innerHTML = `
    ${header("목표 준비 중", "gray")}
    <p class="label">오늘의 목표</p>
    <div class="page-card" aria-live="polite">
      <p class="pc-empty">목표 기준을 준비하고 있어요</p>
      <p class="pc-empty-hint">완료되면 현재 페이지부터 살펴볼게요.</p>
    </div>`
}

async function setGoalAndResumeCurrentPage(
  rawGoalText: string,
  availableTimeMinutes: number | null,
): Promise<GoalInfo | null> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kibitzer:set-goal",
      rawGoalText,
      availableTimeMinutes,
    }) as { ok?: boolean; goal?: GoalInfo } | undefined
    return response?.ok ? response.goal ?? null : null
  } catch {
    return null
  }
}

async function submitGoal(): Promise<void> {
  const input = document.getElementById("goal-input") as HTMLInputElement
  const budgetInput = document.getElementById("time-budget-input") as HTMLInputElement
  const submit = document.getElementById("goal-submit") as HTMLButtonElement
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }
  const rawBudget = budgetInput.value.trim()
  const availableTimeMinutes = rawBudget ? Number.parseInt(rawBudget, 10) : null
  if (
    rawBudget
    && (availableTimeMinutes === null || !Number.isFinite(availableTimeMinutes)
      || availableTimeMinutes < 1 || availableTimeMinutes > 1440)
  ) {
    budgetInput.focus()
    return
  }
  submit.disabled = true
  pendingGoalText = text
  renderGoalPreparing()
  const goal = await setGoalAndResumeCurrentPage(text, availableTimeMinutes)
  if (!goal) {
    handleUnreachable()
    return
  }
  currentGoalBudgetMinutes = goal.available_time_minutes ?? null
  pendingGoalText = null
  editing = false
  notifyBadge()
  await refresh()
}

// ---- 지금 페이지 card (D5) ----
// Pull-only: reports the effective verdict for the page behind the popup and
// takes page-fact labels ("이 페이지가 목표와 관련 있냐"). A label overrides
// the product verdict while the detector's original verdict remains available
// to replay/audit. `related` also feeds the exemplar path; labeling never prompts.

const TIER_NAMES: Record<number, string> = {
  0: "Tier 0 · 어휘 매칭",
  1: "Tier 1 · LLM 재심",
  2: "Tier 2 · 본문 확인",
}

function pageBelief(verdict: LatestObservation["verdict"]): { dot: string; text: string } {
  if (verdict === "OK") return { dot: "ok", text: "관련 있다고 보는 중" }
  if (verdict === "DRIFT") return { dot: "drift", text: "이탈로 보는 중" }
  return { dot: "unknown", text: "판정 정보를 확인할 수 없어요" }
}

type PageCardProcessingStage = CurrentPageProcessingStage

const PAGE_PROCESSING_COPY: Record<PageCardProcessingStage, { text: string; hint?: string }> = {
  tier0: { text: "관련성을 빠르게 판단하고 있어요" },
  tier1: { text: "애매한 판단을 다시 확인하고 있어요" },
}

// The 맞아/아니 prefix agrees or disagrees with the displayed belief, but the
// label itself is always the page-fact ("관련 있다" / "이탈이다").
function pageLabelButtons(page: LatestObservation): { related: string; drift: string } {
  if (page.verdict === "OK") return { related: "맞아, 관련 있어", drift: "아니, 이탈이야" }
  if (page.verdict === "DRIFT") return { related: "아니, 관련 있어", drift: "맞아, 이탈이야" }
  return { related: "관련 있어", drift: "이탈이야" }
}

function relevanceDiagnosticHtml(page: LatestObservation): string {
  const original = formatScore(page.features?.r0)
  const override = page.features?.r_override
  if (override === null || override === undefined) return original
  return `<span class="pc-r-original">${original}</span><span class="pc-r-arrow">&rarr;</span><span class="pc-r-override">${formatScore(override)}</span>`
}

function pageDiagnosticsHtml(page: LatestObservation): string {
  const features = page.features ?? {}
  const tier = features.tier_reached
  const tierName = tier === null || tier === undefined ? "–" : (TIER_NAMES[tier] ?? `Tier ${tier}`)
  const anchor =
    features.anchor_eligible === true ? "반영" : features.anchor_eligible === false ? "제외" : "–"
  const reason = page.tier1_reason
    ? `<p class="pc-reason">판정 근거: ${esc(page.tier1_reason)}</p>`
    : ""
  return `
    <div class="pc-diag">
      <div class="row"><span class="k">판정 단계</span><span>${tierName}</span></div>
      <div class="row"><span class="k">r0 / τ</span><span>${relevanceDiagnosticHtml(page)} / ${formatScore(page.tau_ok)}</span></div>
      <div class="row"><span class="k">예시 유사도</span><span>${formatScore(features.exemplar_score)}</span></div>
      <div class="row"><span class="k">앵커 반영</span><span>${anchor}</span></div>
    </div>
    ${reason}`
}

function pageCardHtml(
  page: LatestObservation | null,
  offline = false,
  observationSeconds = DEFAULT_OBSERVATION_SECONDS,
  processingStage: PageCardProcessingStage | null = null,
  processingTitle: string | null = null,
  processingHost: string | null = null,
): string {
  if (offline) {
    return `
    <p class="label">지금 페이지</p>
    <div class="page-card">
      <p class="pc-empty">서버에 연결되면 표시돼요</p>
    </div>`
  }
  if (!page) {
    if (processingStage) {
      const copy = PAGE_PROCESSING_COPY[processingStage]
      const host = processingHost ? ` · ${esc(processingHost)}` : ""
      return `
      <p class="label">지금 페이지${host}</p>
      <div class="page-card" aria-live="polite">
        ${processingTitle ? `<p class="pc-title">${esc(processingTitle)}</p>` : ""}
        <p class="pc-belief"><span class="pc-dot unknown"></span>${copy.text}</p>
        ${copy.hint ? `<p class="pc-empty-hint">${copy.hint}</p>` : ""}
      </div>`
    }
    return `
    <p class="label">지금 페이지</p>
    <div class="page-card">
      <p class="pc-empty">이 탭은 아직 관측 전이에요</p>
      <p class="pc-empty-hint">${observationSeconds}초 이상 머물면 관련성을 판단해요.</p>
    </div>`
  }
  const belief = pageBelief(page.verdict)
  const buttons = pageLabelButtons(page)
  const labelNote =
    page.label === "related"
      ? `<p class="pc-note">관련 예시로 기억해요</p>`
      : page.label === "drift"
        ? `<p class="pc-note">이탈로 기록해뒀어요 — 판정 개선에 써요</p>`
        : ""
  const host = page.url_host ? ` · ${esc(page.url_host)}` : ""
  return `
    <p class="label">지금 페이지${host}</p>
    <div class="page-card">
      ${page.title ? `<p class="pc-title">${esc(page.title)}</p>` : ""}
      <p class="pc-belief"><span class="pc-dot ${belief.dot}"></span>${belief.text}</p>
      <div class="btn-row">
        <button id="pl-related" class="btn${page.label === "related" ? " sel" : ""}">${buttons.related}</button>
        <button id="pl-drift" class="btn${page.label === "drift" ? " sel" : ""}">${buttons.drift}</button>
      </div>
      ${labelNote}
      ${devDiagnostics ? pageDiagnosticsHtml(page) : ""}
    </div>`
}

function gaugeShadowEffectLabel(snapshot: GaugeShadowSnapshot): string {
  const last = snapshot.effectLog.at(-1)?.effect
  if (!last) return "효과 없음"
  if (last.type === "request_tier2") {
    return `Tier 2 요청(${last.reason})`
  }
  if (last.type === "nag") return "훈수 후보"
  return "복귀 칭찬 후보"
}

function gaugeShadowDebugHtml(snapshot: GaugeShadowSnapshot | null): string {
  if (!devDiagnostics || !snapshot) return ""
  const s = Math.min(100, Math.max(0, snapshot.state.s))
  const effectCount = snapshot.outboxCount
  return `
    <div class="page-card" aria-label="게이지 섀도 진단">
      <div class="scoreline">
        <span>게이지 섀도</span>
        <strong>${s.toFixed(1)}</strong>
      </div>
      <div class="bar" style="margin-bottom: 8px;">
        <div class="fill" style="width: ${s.toFixed(1)}%;"></div>
      </div>
      <p class="pc-empty-hint">
        m ${snapshot.state.m.toFixed(3)} · 가속 ${snapshot.state.accelTier}단계 · 이벤트 ${snapshot.eventCount}회
      </p>
      <p class="pc-empty-hint">
        ${gaugeShadowEffectLabel(snapshot)} · IndexedDB outbox ${effectCount}건 · 발송 안 함
      </p>
    </div>`
}

async function submitPageLabel(page: LatestObservation, label: PageLabel): Promise<void> {
  if (page.label === label) return
  for (const id of ["pl-related", "pl-drift"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null
    if (button) button.disabled = true
  }
  const result = await postObservationLabel(page.observation_id, label)
  if (result) {
    if (result.verdict === "OK" || result.verdict === "DRIFT") {
      await syncExplorationHistoryVerdict(result.observation_id, result.verdict)
    }
    notifyBadge()
  }
  await refresh()
}

function renderDashboard(
  state: SessionState,
  goalText: string,
  stats: SessionStats | null,
  health: HealthStatus | null = null,
  page: LatestObservation | null = null,
  offline = false,
  observationSeconds = DEFAULT_OBSERVATION_SECONDS,
  processingStage: PageCardProcessingStage | null = null,
  processingTitle: string | null = null,
  processingHost: string | null = null,
  gaugeShadowSnapshot: GaugeShadowSnapshot | null = null,
): void {
  const pill = TRACKING_PILLS[state.tracking] ?? TRACKING_PILLS.tracking
  const pillLabel =
    state.tracking === "coldstart"
      ? `워밍업 ${Math.min(state.obs_count, state.coldstart_observations)}/${state.coldstart_observations}`
      : pill.label
  const isAlignment = state.controller_type === "alignment"
  const dots = Array.from({ length: state.streak_threshold }, (_, index) =>
    `<span class="dot${index < state.streak ? " filled" : ""}"></span>`,
  ).join("")
  const snoozed = state.tracking === "snoozed"
  const driftLabel = isAlignment ? "누적 정렬도" : "연속 이탈"
  const driftMeter = isAlignment
    ? `<div class="scoreline"><span>A<sub>t</sub></span><strong>${formatScore(state.alignment_score)}</strong></div>`
    : `<div class="dots">${dots}<span class="count">${Math.min(state.streak, state.streak_threshold)} / ${state.streak_threshold}</span></div>`
  const driftHint = isAlignment
    ? `정렬도 ${formatScore(state.theta_low)} 미만이면 말하고, ${formatScore(state.theta_high)} 초과면 회복으로 봅니다.`
    : `${state.streak_threshold}회 연속 이탈 시에만 한 번 말을 겁니다.`
  const gaugeShadow = gaugeShadowDebugHtml(gaugeShadowSnapshot)

  const degraded = health?.tiers.tier1 === "degraded" || health?.tiers.tier2 === "degraded"
  const degradedNote = degraded
    ? `
    <div style="background: var(--amber-bg); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;">
      <p style="margin: 0; font-size: 12px; color: var(--amber-tx);">판정 축소 모드 — LLM 판정 없이 어휘 매칭만 쓰는 중이에요. configs/models.local.yaml을 확인하세요.</p>
    </div>`
    : ""

  const providerFailures = providerFailureDiagnostics(offline ? null : health?.provider_calls)
  const providerFailureNote = providerFailures.length
    ? `<div class="provider-failures">${providerFailures
        .map(
          (failure) => `
      <section class="provider-failure-card ${failure.severity}">
        <p class="provider-failure-title">${esc(failure.title)}</p>
        <p class="provider-failure-summary">${esc(failure.summary)}</p>
        ${failure.guidance ? `<p class="provider-failure-guidance">${esc(failure.guidance)}</p>` : ""}
      </section>`,
        )
        .join("")}</div>`
    : ""

  // Offline renders come from the snapshot: the nag may have expired and its
  // feedback buttons need the server anyway — don't resurrect it.
  const pending = offline ? null : state.pending_intervention
  const whyToggle = pending?.tier1_reason
    ? `
      <button id="why-toggle" style="border: 0; background: none; padding: 0; margin: 0 0 8px; font-size: 11px; color: var(--amber-tx); opacity: .75; cursor: pointer; text-decoration: underline;">왜?</button>
      <p id="why-reason" hidden style="margin: 0 0 8px; font-size: 11.5px; color: var(--amber-tx); opacity: .85;">판정 근거: ${esc(pending.tier1_reason)}</p>`
    : ""
  const pendingCard = pending
    ? `
    <div style="background: var(--amber-bg); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
      <p style="margin: 0 0 ${pending.tier1_reason ? "4px" : "8px"}; font-size: 13px; color: var(--amber-tx);">${esc(pending.message)}</p>
      ${whyToggle}
      <div class="btn-row" style="margin-bottom: 6px;">
        <button id="fb-related" class="btn" style="font-size: 12px;">관련 있어요</button>
        <button id="fb-accepted" class="btn" style="font-size: 12px;">잘 잡았어요</button>
      </div>
      <div class="btn-row">
        <button id="fb-break" class="btn" style="font-size: 12px;">5분만</button>
        <button id="fb-snooze" class="btn" style="font-size: 12px;">30분 조용히</button>
      </div>
    </div>`
    : ""

  const dis = offline ? " disabled" : ""
  root.innerHTML = `
    ${header(offline ? "연결 안 됨" : pillLabel, offline ? "red" : pill.tone)}
    ${offline ? offlineBannerHtml("아래는 마지막으로 본 상태예요. 서버가 켜지면 자동으로 이어가요.") : ""}
    <div style="display: flex; justify-content: flex-end; gap: 8px; margin: -8px 0 6px;">
      <button id="open-report" class="icon-btn">리포트</button>
      <button id="open-history" class="icon-btn">탐색 기록</button>
      <button id="open-settings" class="icon-btn">설정</button>
    </div>
    ${degradedNote}
    ${providerFailureNote}
    ${pendingCard}
    <p class="label">오늘의 목표</p>
    <div class="goal-row">
      <p class="goal-text">${esc(goalText)}</p>
      <button id="goal-edit" class="icon-btn" title="목표 수정"${dis}>수정</button>
    </div>
    ${pageCardHtml(page, offline, observationSeconds, processingStage, processingTitle, processingHost)}
    <p class="label">${driftLabel}</p>
    ${driftMeter}
    <p class="hint">${driftHint}</p>
    ${gaugeShadow}
    <div class="cards">
      <div class="card"><p class="k">관측</p><p class="v">${stats ? stats.observations : "–"}</p></div>
      <div class="card"><p class="k">목표 관련</p><p class="v">${stats ? formatRatio(stats.related_ratio) : "–"}</p></div>
    </div>
    <div class="btn-row">
      <button id="snooze-toggle" class="btn"${dis}>${snoozed ? "지금 재개" : "30분 조용히"}</button>
      <button id="session-end" class="btn"${dis}>세션 종료</button>
    </div>`

  if (pending) {
    const bindFeedback = (id: string, kind: FeedbackKind) => {
      document.getElementById(id)?.addEventListener("click", () => {
        void submitInterventionFeedback(pending, kind)
      })
    }
    bindFeedback("fb-related", "related")
    bindFeedback("fb-accepted", "accepted")
    bindFeedback("fb-break", "break")
    bindFeedback("fb-snooze", "snooze")
    document.getElementById("why-toggle")?.addEventListener("click", () => {
      const reason = document.getElementById("why-reason")
      if (reason) reason.hidden = !reason.hidden
    })
  }

  if (page) {
    document.getElementById("pl-related")?.addEventListener("click", () => {
      void submitPageLabel(page, "related")
    })
    document.getElementById("pl-drift")?.addEventListener("click", () => {
      void submitPageLabel(page, "drift")
    })
  }

  document.getElementById("open-settings")?.addEventListener("click", () => {
    void openSettings()
  })

  document.getElementById("open-report")?.addEventListener("click", () => {
    void openReport()
  })
  document.getElementById("open-history")?.addEventListener("click", () => {
    void openHistory()
  })

  document.getElementById("goal-edit")?.addEventListener("click", () => {
    editing = true
    stopPoll()
    renderSetup(goalText)
  })
  document.getElementById("snooze-toggle")?.addEventListener("click", () => {
    void toggleSnooze(snoozed)
  })
  document.getElementById("session-end")?.addEventListener("click", () => {
    void endSession()
  })
}

async function submitInterventionFeedback(
  pending: PendingIntervention,
  kind: FeedbackKind,
): Promise<void> {
  const result = await postFeedback({
    kind,
    intervention_id: pending.intervention_id,
    observation_id: pending.observation_id ?? null,
  })
  if (
    result?.observation_id &&
    (result.verdict === "OK" || result.verdict === "DRIFT")
  ) {
    await syncExplorationHistoryVerdict(result.observation_id, result.verdict)
  }
  notifyBadge()
  await refresh()
}

async function toggleSnooze(snoozed: boolean): Promise<void> {
  const result = snoozed ? await postSessionSnooze(0) : await postSessionSnooze()
  if (!result) {
    handleUnreachable()
    return
  }
  notifyBadge()
  await refresh()
}

async function endSession(): Promise<void> {
  stopPoll()
  const stats = await postSessionEnd()
  if (!stats) {
    handleUnreachable()
    return
  }
  await clearGaugeShadowSnapshot()
  clearSnapshot()
  summary = stats
  notifyBadge()
  renderSummary(stats)
}

async function openHistory(): Promise<void> {
  historyOpen = true
  settingsOpen = false
  reportOpen = false
  stopPoll()
  const loaded = await loadExplorationHistory()
  if (!loaded.ok) {
    historyOpen = false
    renderHistoryLoadError()
    schedulePoll()
    return
  }
  renderHistory(loaded.entries)
}

function closeHistory(): void {
  historyOpen = false
  void refresh()
}

function renderHistoryLoadError(): void {
  root.innerHTML = `
    <div class="header">
      <button id="history-back" class="icon-btn" title="대시보드로">←</button>
      <span class="name">탐색 기록</span>
    </div>
    <p class="center-note">탐색 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
    <div class="btn-row">
      <button id="history-retry" class="btn">다시 시도</button>
    </div>`

  document.getElementById("history-back")?.addEventListener("click", closeHistory)
  document.getElementById("history-retry")?.addEventListener("click", () => {
    void openHistory()
  })
}

function renderHistory(entries: ExplorationHistoryEntry[]): void {
  const items = entries.length
    ? entries.map(renderHistoryItem).join("")
    : `<p class="center-note">아직 탐색 기록이 없습니다.</p>`

  root.innerHTML = `
    <div class="header">
      <button id="history-back" class="icon-btn" title="대시보드로">←</button>
      <span class="name">탐색 기록</span>
    </div>
    <div class="history-list">${items}</div>`

  document.getElementById("history-back")?.addEventListener("click", closeHistory)
}

function renderHistoryItem(entry: ExplorationHistoryEntry): string {
  const responseIcon = renderHistoryResponseIcon(entry.responseKind)
  return `
    <div class="history-item">
      <div class="history-status">
        ${renderHistoryLight(entry)}
        ${responseIcon}
      </div>
      <div class="history-main">
        <div class="history-title">${esc(historyTitle(entry))}</div>
        <div class="history-url">${esc(entry.url)}</div>
      </div>
    </div>`
}

const VERDICT_LABELS: Record<ExplorationVerdict, string> = { OK: "목표 관련", DRIFT: "이탈" }

// The final (user-corrected) verdict fills the front light; when the user
// overrode the pipeline verdict, the original one peeks out behind it as a
// faded circle — a photo-stack: front = now, back = before.
function renderHistoryLight(entry: ExplorationHistoryEntry): string {
  const systemVerdict = entry.verdict
  const finalVerdict = entry.userVerdict ?? systemVerdict
  if (!finalVerdict) return `<span class="history-light" aria-hidden="true"></span>`
  const finalClass = finalVerdict === "OK" ? "ok" : "drift"
  if (!systemVerdict || systemVerdict === finalVerdict) {
    return `<span class="history-light ${finalClass}" aria-label="${VERDICT_LABELS[finalVerdict]}"></span>`
  }
  const prevClass = systemVerdict === "OK" ? "ok" : "drift"
  const label = `${VERDICT_LABELS[systemVerdict]} → ${VERDICT_LABELS[finalVerdict]} (직접 수정)`
  return `
      <span class="history-light-stack" role="img" aria-label="${label}" title="${label}">
        <span class="prev ${prevClass}"></span>
        <span class="final ${finalClass}"></span>
      </span>`
}

// Icon shapes are Tabler Icons outlines (MIT): message-circle and sparkles.
function renderHistoryResponseIcon(responseKind: ExplorationResponseKind | undefined): string {
  if (responseKind === "intervention") {
    return `
      <span class="history-response intervention" role="img" aria-label="훈수 발생" title="훈수 발생">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293z" />
        </svg>
      </span>`
  }
  if (responseKind === "celebration") {
    return `
      <span class="history-response celebration" role="img" aria-label="칭찬 발생" title="칭찬 발생">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2" />
          <path d="M16 6a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2" />
          <path d="M9 18a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6" />
        </svg>
      </span>`
  }
  return ""
}

function historyTitle(entry: ExplorationHistoryEntry): string {
  const title = entry.title.trim()
  if (title) return title
  try {
    return new URL(entry.url).hostname
  } catch {
    return "제목 없음"
  }
}

async function openReport(): Promise<void> {
  reportOpen = true
  historyOpen = false
  stopPoll()
  const report = await getSessionReport()
  if (!report) {
    handleUnreachable()
    return
  }
  renderReport(report)
}

function closeReport(): void {
  reportOpen = false
  void refresh()
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function renderReport(report: SessionReport): void {
  const ratio = report.related_ratio ?? null

  // Hourly focus strip: one slim bar per bucket, height = related ratio.
  const buckets = report.hourly_related_ratio
  const hourBars = buckets.length
    ? buckets
        .map((bucket) => {
          const r = bucket.related_ratio
          const height = r === null || r === undefined ? 0 : Math.max(8, Math.round(r * 100))
          const empty = bucket.observations === 0
          const hour = formatClock(bucket.hour)
          const title = empty ? `${hour} · 관측 없음` : `${hour} · ${formatRatio(r)} (${bucket.observations}회)`
          const bar = empty
            ? `<div style="width: 100%; height: 4px; background: var(--line, #d1d5db); opacity: .5; border-radius: 2px;"></div>`
            : `<div style="width: 100%; height: ${height}%; min-height: 4px; background: #10B981; opacity: ${0.45 + 0.55 * (r ?? 0)}; border-radius: 2px;"></div>`
          return `<div title="${esc(title)}" style="flex: 1; height: 44px; display: flex; align-items: flex-end;">${bar}</div>`
        })
        .join("")
    : `<p class="subhint" style="margin: 0;">아직 시간대별 데이터가 없어요.</p>`
  const hourRange = buckets.length
    ? `<div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-top: 2px;"><span>${formatClock(buckets[0].hour)}</span><span>${formatClock(buckets[buckets.length - 1].hour)}</span></div>`
    : ""

  const stretch = report.longest_ok_stretch
  const stretchRow = stretch
    ? `<div class="row"><span class="k">최장 집중</span><span>${stretch.minutes}분 (${formatClock(stretch.start)}–${formatClock(stretch.end)})</span></div>`
    : ""

  const feedback = report.feedback_counts
  const feedbackParts = [
    feedback.accepted ? `수락 ${feedback.accepted}` : "",
    feedback.related ? `관련 ${feedback.related}` : "",
    feedback.break ? `5분만 ${feedback.break}` : "",
    feedback.snooze ? `스누즈 ${feedback.snooze}` : "",
  ].filter(Boolean)
  const interventionTotal = Object.values(report.intervention_status_counts).reduce((a, b) => a + b, 0)
  const feedbackRow = interventionTotal
    ? `<div class="row"><span class="k">훈수</span><span>${interventionTotal}회${feedbackParts.length ? ` · ${feedbackParts.join(" · ")}` : ""}</span></div>`
    : ""

  const driftHosts = report.top_drift_hosts
    .slice(0, 3)
    .map((h) => `<div class="row"><span class="k" style="overflow: hidden; text-overflow: ellipsis;">${esc(h.host)}</span><span>${h.count}회</span></div>`)
    .join("")

  // Recent judgment reasons — the "왜?" history (tier1-reviewed entries first).
  const reasons = report.judgments
    .filter((j) => j.tier1_reason)
    .slice(-3)
    .reverse()
    .map(
      (j) => `
      <div style="margin-bottom: 6px;">
        <p style="margin: 0; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(j.title ?? j.url_host ?? "")}</p>
        <p style="margin: 0; font-size: 11.5px;">${j.verdict === "DRIFT" ? "이탈" : "관련"} — ${esc(j.tier1_reason ?? "")}</p>
      </div>`,
    )
    .join("")

  root.innerHTML = `
    <div class="header">
      <button id="report-back" class="icon-btn" title="대시보드로">←</button>
      <span class="name">오늘 리포트</span>
    </div>
    <p class="label">목표 관련 시간</p>
    <div class="bar"><div class="fill" style="width: ${ratio === null ? 0 : Math.round(ratio * 100)}%"></div></div>
    <p class="label">시간대별 집중</p>
    <div style="display: flex; gap: 3px; align-items: flex-end;">${hourBars}</div>
    ${hourRange}
    <div class="rows" style="margin-top: 10px;">
      <div class="row"><span class="k">세션 시간</span><span>${formatDuration(report.duration_seconds)}</span></div>
      <div class="row"><span class="k">관측</span><span>${report.observations}회 · 관련 ${report.ok} · 이탈 ${report.drift}</span></div>
      ${stretchRow}
      ${feedbackRow}
    </div>
    ${driftHosts ? `<p class="label">자주 샌 곳</p><div class="rows">${driftHosts}</div>` : ""}
    ${reasons ? `<p class="label">최근 판정 근거</p>${reasons}` : ""}`

  document.getElementById("report-back")?.addEventListener("click", closeReport)
}

function renderSummary(stats: SessionStats): void {
  const interventionText = stats.interventions
    ? `${stats.interventions}회 · 수락 ${stats.interventions_accepted}회`
    : "없음"
  const driftRow = stats.top_drift_host
    ? `<div class="row"><span class="k">최다 이탈</span><span>${esc(stats.top_drift_host)} · ${stats.top_drift_count}회</span></div>`
    : ""
  const ratio = stats.related_ratio ?? null

  root.innerHTML = `
    ${header("세션 종료", "gray")}
    <p class="label">목표 관련 시간</p>
    <div class="bar"><div class="fill" style="width: ${ratio === null ? 0 : Math.round(ratio * 100)}%"></div></div>
    <div class="rows">
      <div class="row"><span class="k">세션 시간</span><span>${formatDuration(stats.duration_seconds)}</span></div>
      <div class="row"><span class="k">관측</span><span>${stats.observations}회</span></div>
      <div class="row"><span class="k">목표 관련</span><span>${formatRatio(ratio)}</span></div>
      <div class="row"><span class="k">개입</span><span>${interventionText}</span></div>
      ${driftRow}
    </div>
    <div class="btn-row">
      <button id="new-session" class="btn primary">새 목표 시작</button>
    </div>`

  document.getElementById("new-session")?.addEventListener("click", () => {
    summary = null
    renderSetup()
  })
}

async function openSettings(): Promise<void> {
  settingsOpen = true
  historyOpen = false
  stopPoll()
  const [settings, personas] = await Promise.all([getSettings(), getPersonas()])
  if (!settings) {
    handleUnreachable()
    return
  }
  if (personas.length) personaCache = personas
  try {
    renderSettings(settings, personaCache)
  } catch {
    handleUnreachable()
  }
}

function closeSettings(): void {
  settingsOpen = false
  void refresh()
}

function renderSettings(settings: Settings, personas: PersonaSummary[]): void {
  const personaCards = personas
    .map(
      (persona) => `
    <div class="pcard${persona.key === settings.persona ? " sel" : ""}" data-persona="${esc(persona.key)}">
      <span class="pname">${esc(persona.name)}</span>
      <span class="phint">${esc(PERSONA_HINTS[persona.key] ?? "사용자 정의")}</span>
    </div>`,
    )
    .join("")
  const controllerButtons = CONTROLLERS.map(
    (controller) => `
      <button class="segbtn${controller.type === settings.controller.type ? " sel" : ""}"
        data-controller="${controller.type}">
        <span>${controller.label}</span><small>${controller.hint}</small>
      </button>`,
  ).join("")
  const controllerControls =
    settings.controller.type === "alignment"
      ? `
    <div class="setrow">
      <span class="grow">평활 α</span>
      <input id="controller-alpha" class="number" type="number" min="0" max="0.99" step="0.01"
        value="${settings.controller.alignment_alpha}" />
    </div>
    <div class="setrow">
      <span class="grow">개입 θ</span>
      <input id="controller-low" class="number" type="number" min="0" max="1" step="0.01"
        value="${settings.controller.theta_low}" />
    </div>
    <div class="setrow">
      <span class="grow">회복 θ</span>
      <input id="controller-high" class="number" type="number" min="0" max="1" step="0.01"
        value="${settings.controller.theta_high}" />
    </div>
    <p class="subhint">A안은 관측별 관련도 r의 EWMA가 낮아지고, 회복 임계값을 넘기 전까지 같은 이탈 구간으로 봅니다.</p>`
      : `
    <div class="setrow">
      <span class="grow">연속 횟수</span>
      <input id="controller-k" class="number" type="number" min="1" max="20" step="1"
        value="${settings.controller.k}" />
      <span style="color: var(--muted);">회</span>
    </div>
    <p class="subhint">B안은 OK가 나오면 카운터를 0으로 돌리고, DRIFT가 연속으로 쌓일 때만 말합니다.</p>`

  root.innerHTML = `
    <div class="header">
      <button id="settings-back" class="icon-btn" title="대시보드로">←</button>
      <span class="name">설정</span>
    </div>
    <div id="settings-error" class="settings-error" role="alert" hidden></div>
    <p class="label">페르소나</p>
    <div class="pers">${personaCards}</div>
    <div class="setrow">
      <span class="grow">Tier 0 판정 임계값 τ</span>
      <input id="relevance-tau-ok" class="number" type="number" min="0" max="1" step="0.01"
        value="${settings.relevance.tau_ok}" />
    </div>
    <p class="subhint">r₀ ≥ τ 이면 Tier 0에서 현재 목표와 관련 있는 페이지로 판정합니다</p>
    <p class="label">개입 방식</p>
    <div class="seg">${controllerButtons}</div>
    ${controllerControls}
    <div class="setrow">
      <span class="grow">소리 내어 말하기</span>
      <input id="voice-toggle" type="checkbox" ${settings.voice_enabled ? "checked" : ""} />
    </div>
    <p class="subhint">음성 기능은 현재 macOS say 기반이며 Windows 패키지에서는 기본적으로 꺼져 있습니다.</p>
    <div class="setrow">
      <span class="grow">쿨다운</span>
      <input id="cooldown-seconds" class="number" type="number" min="0" max="86400" step="30"
        value="${settings.cooldown.seconds}" ${settings.cooldown.enabled ? "" : "disabled"} />
      <span style="color: var(--muted);">초</span>
      <input id="cooldown-toggle" type="checkbox" ${settings.cooldown.enabled ? "checked" : ""} />
    </div>
    <p class="subhint">꺼두면 테스트 중 같은 흐름에서도 다음 훈수를 바로 받을 수 있습니다.</p>
    <div class="setrow">
      <span class="grow">관측 대기</span>
      <input id="dwell-observation" class="number" type="number" min="1" max="300" step="1"
        value="${settings.dwell.observation_seconds}" />
      <span style="color: var(--muted);">초</span>
    </div>
    <div class="setrow">
      <span class="grow">본문 확인 대기</span>
      <input id="dwell-tier2" class="number" type="number" min="1" max="300" step="1"
        value="${settings.dwell.tier2_seconds}" />
      <span style="color: var(--muted);">초</span>
    </div>
    <p class="subhint">짧게 들른 페이지는 관측하지 않습니다. 본문 확인 대기는 Tier 2 요청 전에 같은 페이지에 머문 총 시간입니다.</p>
    <div class="setrow">
      <span class="grow">조용한 시간</span>
      <input id="quiet-start" class="time" type="time" value="${esc(settings.quiet_hours.start)}"
        ${settings.quiet_hours.enabled ? "" : "disabled"} />
      <span style="color: var(--muted);">–</span>
      <input id="quiet-end" class="time" type="time" value="${esc(settings.quiet_hours.end)}"
        ${settings.quiet_hours.enabled ? "" : "disabled"} />
      <input id="quiet-toggle" type="checkbox" ${settings.quiet_hours.enabled ? "checked" : ""} />
    </div>
    <p class="subhint">이 시간에는 알림·음성을 억제합니다. 억제된 잔소리도 팝업 카드에는 남습니다.</p>
    <div class="setrow">
      <span class="grow">개발자 진단</span>
      <input id="dev-toggle" type="checkbox" ${devDiagnostics ? "checked" : ""} />
    </div>
    <p class="subhint">지금 페이지 판정 수치와 발송하지 않는 게이지 섀도 상태를 표시합니다.</p>
    <div class="setrow">
      <span class="grow">저장된 활동 데이터</span>
      <button id="delete-activity" class="btn" type="button" style="flex: 0 0 auto; color: var(--red-tx);">모두 삭제</button>
    </div>
    <p class="subhint">세션·목표·관측·알림 기록을 삭제합니다. 설정은 유지됩니다.</p>`

  document.getElementById("settings-back")?.addEventListener("click", closeSettings)

  root.querySelectorAll<HTMLElement>(".pcard").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.dataset.persona
      if (key && key !== settings.persona) void applySettings({ persona: key })
    })
  })
  root.querySelectorAll<HTMLElement>(".segbtn").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.controller as ControllerType | undefined
      if (!type || type === settings.controller.type) return
      void applySettings({ controller: { type } })
    })
  })
  const tauInput = document.getElementById("relevance-tau-ok") as HTMLInputElement | null
  const updateTauOk = () => {
    const tauOk = Number.parseFloat(tauInput?.value ?? "")
    if (Number.isFinite(tauOk) && tauOk >= 0 && tauOk <= 1) {
      void applySettings({ relevance: { tau_ok: tauOk } })
    }
  }
  tauInput?.addEventListener("change", updateTauOk)
  tauInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    updateTauOk()
  })
  const updateControllerK = (event: Event) => {
    const k = Number.parseInt((event.target as HTMLInputElement).value, 10)
    if (!Number.isFinite(k) || k < 1 || k > 20) return
    void applySettings({ controller: { k } })
  }
  document.getElementById("controller-k")?.addEventListener("input", updateControllerK)
  document.getElementById("controller-k")?.addEventListener("change", updateControllerK)

  const updateControllerAlpha = (event: Event) => {
    const value = Number.parseFloat((event.target as HTMLInputElement).value)
    if (!Number.isFinite(value) || value < 0 || value > 0.99) return
    void applySettings({ controller: { alignment_alpha: value } })
  }
  const updateControllerLow = (event: Event) => {
    const value = Number.parseFloat((event.target as HTMLInputElement).value)
    if (!Number.isFinite(value) || value < 0 || value >= settings.controller.theta_high) return
    void applySettings({ controller: { theta_low: value } })
  }
  const updateControllerHigh = (event: Event) => {
    const value = Number.parseFloat((event.target as HTMLInputElement).value)
    if (!Number.isFinite(value) || value > 1 || value <= settings.controller.theta_low) return
    void applySettings({ controller: { theta_high: value } })
  }
  document.getElementById("controller-alpha")?.addEventListener("input", updateControllerAlpha)
  document.getElementById("controller-alpha")?.addEventListener("change", updateControllerAlpha)
  document.getElementById("controller-low")?.addEventListener("input", updateControllerLow)
  document.getElementById("controller-low")?.addEventListener("change", updateControllerLow)
  document.getElementById("controller-high")?.addEventListener("input", updateControllerHigh)
  document.getElementById("controller-high")?.addEventListener("change", updateControllerHigh)
  document.getElementById("voice-toggle")?.addEventListener("change", (event) => {
    void applySettings({ voice_enabled: (event.target as HTMLInputElement).checked })
  })
  document.getElementById("cooldown-toggle")?.addEventListener("change", (event) => {
    void applySettings({ cooldown: { enabled: (event.target as HTMLInputElement).checked } })
  })
  document.getElementById("cooldown-seconds")?.addEventListener("change", (event) => {
    const seconds = Number.parseInt((event.target as HTMLInputElement).value, 10)
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) {
      void applySettings({ cooldown: { seconds } })
    }
  })
  document.getElementById("dwell-observation")?.addEventListener("change", (event) => {
    const seconds = Number.parseInt((event.target as HTMLInputElement).value, 10)
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 300) {
      void applySettings({ dwell: { observation_seconds: seconds } })
    }
  })
  document.getElementById("dwell-tier2")?.addEventListener("change", (event) => {
    const seconds = Number.parseInt((event.target as HTMLInputElement).value, 10)
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 300) {
      void applySettings({ dwell: { tier2_seconds: seconds } })
    }
  })
  document.getElementById("quiet-toggle")?.addEventListener("change", (event) => {
    void applySettings({ quiet_hours: { enabled: (event.target as HTMLInputElement).checked } })
  })
  document.getElementById("quiet-start")?.addEventListener("change", (event) => {
    void applySettings({ quiet_hours: { start: (event.target as HTMLInputElement).value } })
  })
  document.getElementById("quiet-end")?.addEventListener("change", (event) => {
    void applySettings({ quiet_hours: { end: (event.target as HTMLInputElement).value } })
  })
  document.getElementById("dev-toggle")?.addEventListener("change", (event) => {
    devDiagnostics = (event.target as HTMLInputElement).checked
    try {
      localStorage.setItem(DEV_DIAGNOSTICS_KEY, devDiagnostics ? "1" : "0")
    } catch {
      // Preference simply won't survive the popup closing.
    }
  })
  document.getElementById("delete-activity")?.addEventListener("click", () => {
    void deleteActivityData()
  })
}

async function deleteActivityData(): Promise<void> {
  if (!window.confirm("저장된 모든 활동 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return
  if (!(await deleteAllActivityData())) {
    handleUnreachable()
    return
  }

  if (!(await clearGaugeShadowSnapshot())) {
    window.alert("로컬 게이지 데이터를 삭제하지 못했습니다. 확장을 다시 연 뒤 재시도해 주세요.")
    return
  }
  await chrome.storage.session.clear().catch(() => undefined)
  const notificationIds = await new Promise<string[]>((resolve) => {
    chrome.notifications.getAll((notifications) => resolve(Object.keys(notifications)))
  })
  await Promise.all(
    notificationIds.map(
      (notificationId) =>
        new Promise<void>((resolve) => {
          chrome.notifications.clear(notificationId, () => resolve())
        }),
    ),
  )
  clearSnapshot()
  chrome.runtime.reload()
}

async function applySettings(patch: Parameters<typeof putSettings>[0]): Promise<void> {
  const result = await putSettings(patch)
  if (result.kind === "unreachable") {
    handleUnreachable()
    return
  }
  if (result.kind === "http_error") {
    const error = document.getElementById("settings-error")
    if (!error) return
    const prefix = result.status >= 400 && result.status < 500
      ? "설정값을 확인해 주세요."
      : "설정을 저장하지 못했어요."
    error.textContent = result.detail
      ? `${prefix} ${result.detail}`
      : `${prefix} (HTTP ${result.status})`
    error.hidden = false
    return
  }
  renderSettings(result.settings, personaCache)
}

void refresh()

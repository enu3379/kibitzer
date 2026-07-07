import {
  ControllerType,
  FeedbackKind,
  HealthTiers,
  PendingIntervention,
  SessionState,
  SessionStats,
  Settings,
  createSession,
  getCurrentSession,
  getHealthTiers,
  getSessionState,
  getSessionStats,
  getSettings,
  postFeedback,
  postSessionEnd,
  postSessionSnooze,
  putSettings,
  setGoal,
} from "../lib/api"

const POLL_MS = 2000
const TRACKING_PILLS: Record<SessionState["tracking"], { label: string; tone: string }> = {
  coldstart: { label: "워밍업", tone: "gray" },
  tracking: { label: "추적 중", tone: "green" },
  snoozed: { label: "스누즈 중", tone: "blue" },
  cooldown: { label: "쿨다운", tone: "amber" },
}

// Same-owner duplication with configs/personas.yaml until P1 ships GET /personas.
const PERSONAS: { key: string; name: string; hint: string }[] = [
  { key: "dry_kibitzer", name: "건조한 훈수꾼", hint: "영국식 무표정 반어" },
  { key: "chungcheong", name: "느긋한 이웃", hint: "말을 아끼는 함축 화법" },
  { key: "kyoto", name: "교토식 안주인", hint: "칭찬으로 포장한 지적" },
  { key: "quiet_coach", name: "조용한 코치", hint: "수치심 없는 리다이렉트" },
]

const CONTROLLERS: { type: ControllerType; label: string; hint: string }[] = [
  { type: "alignment", label: "A안", hint: "EWMA" },
  { type: "streak", label: "B안", hint: "연속 이탈" },
]

const root = document.getElementById("root") as HTMLElement

let editing = false
let summary: SessionStats | null = null
let settingsOpen = false
let pollTimer: number | undefined

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  )
}

function schedulePoll(): void {
  stopPoll()
  pollTimer = window.setTimeout(() => {
    void refresh()
  }, POLL_MS)
}

function stopPoll(): void {
  if (pollTimer) window.clearTimeout(pollTimer)
  pollTimer = undefined
}

function notifyBadge(): void {
  void chrome.runtime.sendMessage({ type: "kibitzer:refresh-badge" }).catch(() => undefined)
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

async function refresh(): Promise<void> {
  if (editing || summary || settingsOpen) return
  const result = await getSessionState()
  if (result.kind === "unreachable") {
    renderUnreachable()
    schedulePoll()
    return
  }
  if (result.kind === "no_session") {
    stopPoll()
    renderSetup(false)
    return
  }
  if (!result.state.has_goal) {
    stopPoll()
    renderSetup(true)
    return
  }
  const [current, stats, tiers] = await Promise.all([
    getCurrentSession(),
    getSessionStats(),
    getHealthTiers(),
  ])
  renderDashboard(result.state, current?.goal?.raw_text ?? "", stats, tiers)
  schedulePoll()
}

function renderUnreachable(): void {
  root.innerHTML = `
    ${header("연결 안 됨", "red")}
    <p class="center-note">로컬 서버(127.0.0.1:8765)에 연결할 수 없어요.<br />서버를 켜면 자동으로 다시 연결합니다.</p>`
}

function renderSetup(sessionExists: boolean, currentGoal = ""): void {
  root.innerHTML = `
    ${header("목표 없음", "amber")}
    <p class="label">오늘의 목표</p>
    <input id="goal-input" class="goal-input" type="text"
      placeholder="예: 핀란드 여행 일정 계획하기" value="${esc(currentGoal)}" />
    <div class="btn-row">
      <button id="goal-submit" class="btn primary">추적 시작</button>
      ${editing ? '<button id="goal-cancel" class="btn">취소</button>' : ""}
    </div>`

  const input = document.getElementById("goal-input") as HTMLInputElement
  const submit = document.getElementById("goal-submit") as HTMLButtonElement
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitGoal(sessionExists)
  })
  submit.addEventListener("click", () => {
    void submitGoal(sessionExists)
  })
  document.getElementById("goal-cancel")?.addEventListener("click", () => {
    editing = false
    settingsOpen = false
    void refresh()
  })
}

async function submitGoal(sessionExists: boolean): Promise<void> {
  const input = document.getElementById("goal-input") as HTMLInputElement
  const submit = document.getElementById("goal-submit") as HTMLButtonElement
  const text = input.value.trim()
  if (!text) {
    input.focus()
    return
  }
  submit.disabled = true
  if (!sessionExists) {
    const session = await createSession()
    if (!session) {
      renderUnreachable()
      schedulePoll()
      return
    }
  }
  const goal = await setGoal(text)
  if (!goal) {
    renderUnreachable()
    schedulePoll()
    return
  }
  editing = false
  notifyBadge()
  await refresh()
}

function renderDashboard(
  state: SessionState,
  goalText: string,
  stats: SessionStats | null,
  tiers: HealthTiers | null = null,
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

  const degraded = tiers?.tier1 === "degraded" || tiers?.tier2 === "degraded"
  const degradedNote = degraded
    ? `
    <div style="background: var(--amber-bg); border-radius: 8px; padding: 8px 12px; margin-bottom: 12px;">
      <p style="margin: 0; font-size: 12px; color: var(--amber-tx);">판정 축소 모드 — LLM 판정 없이 어휘 매칭만 쓰는 중이에요. configs/models.local.yaml을 확인하세요.</p>
    </div>`
    : ""

  const pending = state.pending_intervention
  const pendingCard = pending
    ? `
    <div style="background: var(--amber-bg); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
      <p style="margin: 0 0 8px; font-size: 13px; color: var(--amber-tx);">${esc(pending.message)}</p>
      <div class="btn-row">
        <button id="fb-related" class="btn" style="font-size: 12px;">관련 있어요</button>
        <button id="fb-accepted" class="btn" style="font-size: 12px;">잘 잡았어요</button>
        <button id="fb-snooze" class="btn" style="font-size: 12px;">30분 조용히</button>
      </div>
    </div>`
    : ""

  root.innerHTML = `
    ${header(pillLabel, pill.tone)}
    <div style="display: flex; justify-content: flex-end; margin: -8px 0 6px;">
      <button id="open-settings" class="icon-btn">설정</button>
    </div>
    ${degradedNote}
    ${pendingCard}
    <p class="label">오늘의 목표</p>
    <div class="goal-row">
      <p class="goal-text">${esc(goalText)}</p>
      <button id="goal-edit" class="icon-btn" title="목표 수정">수정</button>
    </div>
    <p class="label">${driftLabel}</p>
    ${driftMeter}
    <p class="hint">${driftHint}</p>
    <div class="cards">
      <div class="card"><p class="k">관측</p><p class="v">${stats ? stats.observations : "–"}</p></div>
      <div class="card"><p class="k">목표 관련</p><p class="v">${stats ? formatRatio(stats.related_ratio) : "–"}</p></div>
    </div>
    <div class="btn-row">
      <button id="snooze-toggle" class="btn">${snoozed ? "지금 재개" : "30분 조용히"}</button>
      <button id="session-end" class="btn">세션 종료</button>
    </div>`

  if (pending) {
    const bindFeedback = (id: string, kind: FeedbackKind) => {
      document.getElementById(id)?.addEventListener("click", () => {
        void submitInterventionFeedback(pending, kind)
      })
    }
    bindFeedback("fb-related", "related")
    bindFeedback("fb-accepted", "accepted")
    bindFeedback("fb-snooze", "snooze")
  }

  document.getElementById("open-settings")?.addEventListener("click", () => {
    void openSettings()
  })

  document.getElementById("goal-edit")?.addEventListener("click", () => {
    editing = true
    stopPoll()
    renderSetup(true, goalText)
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
  await postFeedback({
    kind,
    intervention_id: pending.intervention_id,
    observation_id: pending.observation_id ?? null,
  })
  notifyBadge()
  await refresh()
}

async function toggleSnooze(snoozed: boolean): Promise<void> {
  const result = snoozed ? await postSessionSnooze(0) : await postSessionSnooze()
  if (!result) {
    renderUnreachable()
    schedulePoll()
    return
  }
  notifyBadge()
  await refresh()
}

async function endSession(): Promise<void> {
  stopPoll()
  const stats = await postSessionEnd()
  if (!stats) {
    renderUnreachable()
    schedulePoll()
    return
  }
  summary = stats
  notifyBadge()
  renderSummary(stats)
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
    renderSetup(false)
  })
}

async function openSettings(): Promise<void> {
  settingsOpen = true
  stopPoll()
  const settings = await getSettings()
  if (!settings) {
    settingsOpen = false
    renderUnreachable()
    schedulePoll()
    return
  }
  try {
    renderSettings(settings)
  } catch {
    settingsOpen = false
    renderUnreachable()
    schedulePoll()
  }
}

function closeSettings(): void {
  settingsOpen = false
  void refresh()
}

function renderSettings(settings: Settings): void {
  const personaCards = PERSONAS.map(
    (persona) => `
    <div class="pcard${persona.key === settings.persona ? " sel" : ""}" data-persona="${persona.key}">
      <span class="pname">${esc(persona.name)}</span>
      <span class="phint">${esc(persona.hint)}</span>
    </div>`,
  ).join("")
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
    <p class="label">페르소나</p>
    <div class="pers">${personaCards}</div>
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
      <input id="cooldown-seconds" class="number" type="number" min="0" step="30"
        value="${settings.cooldown.seconds}" ${settings.cooldown.enabled ? "" : "disabled"} />
      <span style="color: var(--muted);">초</span>
      <input id="cooldown-toggle" type="checkbox" ${settings.cooldown.enabled ? "checked" : ""} />
    </div>
    <p class="subhint">꺼두면 테스트 중 같은 흐름에서도 다음 훈수를 바로 받을 수 있습니다.</p>
    <div class="setrow">
      <span class="grow">조용한 시간</span>
      <input id="quiet-start" class="time" type="time" value="${esc(settings.quiet_hours.start)}"
        ${settings.quiet_hours.enabled ? "" : "disabled"} />
      <span style="color: var(--muted);">–</span>
      <input id="quiet-end" class="time" type="time" value="${esc(settings.quiet_hours.end)}"
        ${settings.quiet_hours.enabled ? "" : "disabled"} />
      <input id="quiet-toggle" type="checkbox" ${settings.quiet_hours.enabled ? "checked" : ""} />
    </div>
    <p class="subhint">이 시간에는 알림·음성을 억제합니다. 억제된 잔소리도 팝업 카드에는 남습니다.</p>`

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
  const updateControllerK = (event: Event) => {
    const k = Number.parseInt((event.target as HTMLInputElement).value, 10)
    if (!Number.isFinite(k) || k < 1) return
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
    if (Number.isFinite(seconds) && seconds >= 0) {
      void applySettings({ cooldown: { seconds } })
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
}

async function applySettings(patch: Parameters<typeof putSettings>[0]): Promise<void> {
  const updated = await putSettings(patch)
  if (!updated) {
    settingsOpen = false
    renderUnreachable()
    schedulePoll()
    return
  }
  renderSettings(updated)
}

void refresh()

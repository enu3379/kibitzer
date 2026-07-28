// Popup: setup (goal + time) when no goal; active (S + goal + mode) once set; a session
// summary view after 종료하기 (stats snapshot + async Tier-2 persona recap).
// Settings, persona, Ollama, and debug tools live on the options page.

import { bandOf, formatDurationKo } from "../lib/sessionStats.ts"
import type { HostSlice, SessionReport } from "../lib/sessionReport.ts"
import type { ComparisonDelta, SessionComparison } from "../lib/sessionHistory.ts"
import type { CardId } from "../lib/reportCards.ts"

interface StateResponse {
  goal: { text: string; availableMinutes: number | null; startedAt: number } | null
  s: number
  accelTier: number
  snoozedUntil?: number | null
  ollama?: { apiKeys: string[]; tier1Model: string; tier2Model: string }
  persona?: string
  personas?: Array<{ key: string; name: string }>
  health?: { ok: boolean; kind: string; message: string; ts: number } | null
}

interface SummaryTopPage {
  title: string
  host: string
  ms: number
  verdict: string
}

interface SummaryStats {
  goalText: string
  sessionMinutes: number
  activeMs: number
  pagesTotal: number
  pagesOk: number
  okRatio: number | null
  validMs: number
  nagCount: number
  topPage: SummaryTopPage | null
}

interface SessionSummary {
  epoch: number
  stats: SummaryStats
  report: SessionReport
  comparison: SessionComparison
  cards: CardId[]
  comment: { status: "pending" | "ready" | "fallback"; text: string | null }
  seen: boolean
  createdAt: number
}

const activeView = document.getElementById("active") as HTMLDivElement
const setupView = document.getElementById("setup") as HTMLDivElement
const summaryView = document.getElementById("summary") as HTMLDivElement
const goalTextEl = document.getElementById("goalText") as HTMLElement
const timeVisEl = document.getElementById("timeVis") as HTMLElement
const activeMeterEl = document.getElementById("activeMeter") as HTMLElement
const meterFillEl = document.getElementById("meterFill") as HTMLElement
const stateWordEl = document.getElementById("stateWord") as HTMLElement
const scoreNumEl = document.getElementById("scoreNum") as HTMLElement
const modeEl = document.getElementById("mode") as HTMLElement
const personaActiveEl = document.getElementById("personaActive") as HTMLElement
const providerWarnEl = document.getElementById("providerWarn") as HTMLElement
const goalInput = document.getElementById("goal") as HTMLInputElement
const minutesInput = document.getElementById("minutes") as HTMLInputElement
const startButton = document.getElementById("set") as HTMLButtonElement
const editButton = document.getElementById("edit") as HTMLButtonElement
const pauseButton = document.getElementById("pause") as HTMLButtonElement
const endButton = document.getElementById("end") as HTMLButtonElement
const sumGoalEl = document.getElementById("sumGoal") as HTMLElement
const sumRatioEl = document.getElementById("sumRatio") as HTMLElement
const sumRatioMeter = document.getElementById("sumRatioMeter") as HTMLElement
const sumTimeEl = document.getElementById("sumTime") as HTMLElement
const sumTimeMeter = document.getElementById("sumTimeMeter") as HTMLElement
const sumNagsEl = document.getElementById("sumNags") as HTMLElement
const sumTopWrap = document.getElementById("sumTopWrap") as HTMLElement
const sumTopTitleEl = document.getElementById("sumTopTitle") as HTMLElement
const sumTopDot = document.getElementById("sumTopDot") as HTMLElement
const sumTopMetaEl = document.getElementById("sumTopMeta") as HTMLElement
const sumMoreButton = document.getElementById("sumMore") as HTMLButtonElement
const sumCommentEl = document.getElementById("sumComment") as HTMLElement
const sumPersonaEl = document.getElementById("sumPersona") as HTMLElement
const sumCommentTextEl = document.getElementById("sumCommentText") as HTMLElement
const sumCommentNoteEl = document.getElementById("sumCommentNote") as HTMLElement
const sumReportEl = document.getElementById("sumReport") as HTMLElement
const sumDoneButton = document.getElementById("sumDone") as HTMLButtonElement

type View = "setup" | "active" | "summary"
let view: View = "setup"
let current: StateResponse | null = null
let currentSummary: SessionSummary | null = null
let commentRevealed = false

async function getState(): Promise<StateResponse | null> {
  try {
    return (await chrome.runtime.sendMessage({ type: "get-state" })) as StateResponse
  } catch {
    return null
  }
}

async function getSummary(): Promise<SessionSummary | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: "get-session-summary" })) as {
      summary?: SessionSummary | null
    }
    return res?.summary ?? null
  } catch {
    return null
  }
}

function renderMode(state: StateResponse): void {
  const on = Boolean(state.ollama?.apiKeys?.length)
  modeEl.textContent = on ? "● AI 판정 활성화" : "○ AI 판정 꺼짐 (제목 유사도만)"
  modeEl.classList.toggle("on", on)
}

function personaName(state: StateResponse | null): string {
  const found = state?.personas?.find((p) => p.key === state.persona)
  return found?.name ?? ""
}

function renderProviderWarn(state: StateResponse): void {
  const ollamaOn = Boolean(state.ollama?.apiKeys?.length)
  const health = state.health
  if (ollamaOn && health && !health.ok) {
    providerWarnEl.textContent = `⚠ LLM 오류: ${health.message} · Tier-0(제목 유사도)만 동작 중`
    providerWarnEl.hidden = false
  } else {
    providerWarnEl.hidden = true
  }
}

function showSetup(): void {
  view = "setup"
  setupView.hidden = false
  activeView.hidden = true
  summaryView.hidden = true
  if (current?.goal) {
    goalInput.value = current.goal.text
    minutesInput.value = current.goal.availableMinutes != null ? String(current.goal.availableMinutes) : ""
  }
  goalInput.focus()
}

function isPaused(state: StateResponse | null): boolean {
  return state?.snoozedUntil != null && state.snoozedUntil > Date.now()
}

// Elapsed fraction of the time budget (0..1), or null when the goal has no minutes.
function elapsedFrac(goal: NonNullable<StateResponse["goal"]>): number | null {
  if (goal.availableMinutes == null) return null
  const total = goal.availableMinutes * 60_000
  if (total <= 0) return null
  return Math.max(0, Math.min(1, (Date.now() - goal.startedAt) / total))
}

// Immersion band → active-gauge class + Korean state word (paused overrides the band).
function activeBand(s: number, paused: boolean): { cls: string; word: string } {
  if (paused) return { cls: "agauge paused", word: "일시정지" }
  const b = bandOf(s) // "ok" | "warn" | "bad"
  if (b === "ok") return { cls: "agauge", word: "집중" }
  if (b === "warn") return { cls: "agauge warn", word: "흔들림" }
  return { cls: "agauge bad", word: "이탈" }
}

// Sundial time visual: a sprout lit by the sun (rides a dome start→end) casting a shadow
// whose length/direction tells how far the session has run. Monochrome but for the leaves.
function sundialSVG(frac: number): string {
  const cx = 62, gy = 62, rx = 48, ry = 46, n = 48
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) {
    const t = Math.PI * (1 - i / n)
    pts.push([cx + rx * Math.cos(t), gy - ry * Math.sin(t)])
  }
  const k = Math.round(frac * n)
  const [sx, sy] = pts[k]
  const objH = 22, base = gy - objH + 6, pw = 13, ptop = gy - 8
  const leaf = (deg: number, len: number, wid: number) => {
    const a = (deg * Math.PI) / 180, tx = cx + len * Math.cos(a), ty = base + len * Math.sin(a)
    const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2)
    const mx = (cx + tx) / 2, my = (base + ty) / 2
    const d = `M${cx.toFixed(1)},${base.toFixed(1)} Q${(mx + px * wid).toFixed(1)},${(my + py * wid).toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} Q${(mx - px * wid).toFixed(1)},${(my - py * wid).toFixed(1)} ${cx.toFixed(1)},${base.toFixed(1)} Z`
    return `<path d="${d}" fill="var(--sd-leaf)"/><path d="M${cx.toFixed(1)},${base.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}" stroke="var(--sd-bg)" stroke-width="0.8" stroke-linecap="round" opacity="0.5"/>`
  }
  const sprout =
    `<path d="M${cx - pw / 2},${ptop} L${cx + pw / 2},${ptop} L${cx + pw / 2 - 2},${gy} L${cx - pw / 2 + 2},${gy} Z" fill="var(--sd-ink)"/>` +
    `<path d="M${cx},${ptop} L${cx},${base}" stroke="var(--sd-ink)" stroke-width="1.7" stroke-linecap="round"/>` +
    leaf(-152, 13.5, 3) + leaf(-44, 12.5, 2.8)
  const aimY = gy - objH * 0.7
  const d = Math.hypot(cx - sx, aimY - sy), phi = Math.atan2(aimY - sy, cx - sx), hw = (15 * Math.PI) / 180, r = d * 1.06
  const b1x = sx + r * Math.cos(phi - hw), b1y = sy + r * Math.sin(phi - hw)
  const b2x = sx + r * Math.cos(phi + hw), b2y = sy + r * Math.sin(phi + hw)
  const dir = sx >= cx ? -1 : 1
  const elev = Math.atan2(gy - sy, Math.abs(sx - cx) + 0.5)
  const L = Math.min(44, objH / Math.tan(elev) + 4)
  let rays = ""
  for (let a = 0; a < 8; a++) {
    const q = (a * Math.PI) / 4
    rays += `<line x1="${(sx + 7 * Math.cos(q)).toFixed(1)}" y1="${(sy + 7 * Math.sin(q)).toFixed(1)}" x2="${(sx + 9.5 * Math.cos(q)).toFixed(1)}" y2="${(sy + 9.5 * Math.sin(q)).toFixed(1)}" stroke="var(--sd-ink)" stroke-width="1.2" stroke-linecap="round"/>`
  }
  return `<svg width="124" height="78" viewBox="0 0 124 78" role="img" aria-label="시간 경과">
    <defs><radialGradient id="kbzbeam" gradientUnits="userSpaceOnUse" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(1)}">
      <stop offset="0.12" stop-color="var(--sd-ink)" stop-opacity="0.03"/>
      <stop offset="0.6" stop-color="var(--sd-ink)" stop-opacity="0.19"/>
      <stop offset="1" stop-color="var(--sd-ink)" stop-opacity="0"/></radialGradient></defs>
    <polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="var(--sd-line)" stroke-width="1.5" stroke-dasharray="1 4" stroke-linecap="round"/>
    <line x1="8" y1="${gy}" x2="116" y2="${gy}" stroke="var(--sd-line)" stroke-width="1"/>
    <ellipse cx="${(cx + dir * L * 0.42).toFixed(1)}" cy="${(gy + 1.5).toFixed(1)}" rx="${(L * 0.48 + 5).toFixed(1)}" ry="4.8" fill="var(--sd-ink3)" opacity="0.26"/>
    <path d="M${sx.toFixed(1)},${sy.toFixed(1)} L${b1x.toFixed(1)},${b1y.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${b2x.toFixed(1)},${b2y.toFixed(1)} Z" fill="url(#kbzbeam)"/>
    ${sprout}
    ${rays}<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="var(--sd-ink)"/>
  </svg>`
}

function renderActive(state: StateResponse): void {
  const goal = state.goal
  if (!goal) return
  goalTextEl.textContent = goal.text

  const frac = elapsedFrac(goal)
  if (frac == null) {
    timeVisEl.hidden = true
    timeVisEl.innerHTML = ""
  } else {
    timeVisEl.hidden = false
    timeVisEl.innerHTML = sundialSVG(frac)
  }

  const paused = isPaused(state)
  const b = activeBand(state.s, paused)
  activeMeterEl.className = b.cls
  meterFillEl.style.width = `${state.s}%`
  stateWordEl.innerHTML = `<span class="dot">●</span>${b.word}`
  scoreNumEl.textContent = String(state.s)
  pauseButton.textContent = paused ? "재개" : "일시정지"

  renderMode(state)
  personaActiveEl.textContent = personaName(state) ? `말투 · ${personaName(state)}` : ""
  renderProviderWarn(state)
}

function showActive(state: StateResponse): void {
  view = "active"
  activeView.hidden = false
  setupView.hidden = true
  summaryView.hidden = true
  renderActive(state)
}

function render(state: StateResponse | null): void {
  current = state
  if (view === "summary") return // the summary stays up until 확인
  if (state?.goal) showActive(state)
  else showSetup()
}

// --- session summary view ---------------------------------------------------------

/** Fill a band-colored meter (구간색): ≥66 집중 / 33–65 흔들림 / <33 이탈; null = empty. */
function setMeter(meter: HTMLElement, pct: number | null): void {
  meter.classList.remove("warn", "bad", "empty")
  const fill = meter.querySelector(".fill") as HTMLElement | null
  if (!fill) return
  if (pct == null) {
    meter.classList.add("empty")
    fill.style.width = "0%"
    return
  }
  const clamped = Math.max(0, Math.min(100, pct))
  const band = bandOf(clamped)
  if (band !== "ok") meter.classList.add(band)
  fill.style.width = `${clamped}%`
}

function renderComment(summary: SessionSummary): void {
  const comment = summary.comment
  if (comment.status === "pending") {
    sumPersonaEl.textContent = ""
    sumCommentTextEl.textContent = "한 줄 평 준비 중…"
    sumCommentTextEl.classList.add("loading")
    sumCommentNoteEl.hidden = true
    return
  }
  sumCommentTextEl.classList.remove("loading")
  sumCommentTextEl.textContent = comment.text ?? ""
  if (comment.status === "ready") {
    const name = personaName(current)
    sumPersonaEl.textContent = name ? `${name}의 한 줄 평` : "한 줄 평"
    sumCommentNoteEl.hidden = true
  } else {
    sumPersonaEl.textContent = "세션 한 줄 평"
    sumCommentNoteEl.hidden = summary.stats.pagesTotal === 0
  }
}

function revealComment(): void {
  if (commentRevealed) return
  commentRevealed = true
  sumCommentEl.hidden = false
  sumMoreButton.textContent = "세션 더보기 ▴"
  sumMoreButton.setAttribute("aria-expanded", "true")
  if (currentSummary) renderComment(currentSummary)
}

function collapseComment(): void {
  commentRevealed = false
  sumCommentEl.hidden = true
  sumMoreButton.textContent = "세션 더보기 ▾"
  sumMoreButton.setAttribute("aria-expanded", "false")
}

// --- extended report cards (세션 더보기) -------------------------------------------
// Each card is boxed; only summary.cards are rendered (chosen per-session by the SW).

const SVG_NS = "http://www.w3.org/2000/svg"

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text // textContent: page titles/hosts are untrusted
  return node
}

/** A boxed card with an uppercase header; returns the box and its body to fill. */
function card(title: string): { box: HTMLElement; body: HTMLElement } {
  const box = el("div", "card")
  box.appendChild(el("div", "ch", title))
  const body = el("div")
  box.appendChild(body)
  return { box, body }
}

/** A host bar row: name · bar (width = value/max) · trailing value. */
function rankRow(name: string, pct: number, value: string, bad: boolean): HTMLElement {
  const row = el("div", bad ? "rank bad" : "rank")
  row.appendChild(el("span", "nm", name))
  const bar = el("span", "bar")
  const fill = el("i")
  fill.style.width = `${Math.max(4, Math.min(100, pct))}%`
  bar.appendChild(fill)
  row.appendChild(bar)
  row.appendChild(el("span", "vv", value))
  return row
}

/** A labelled metric with an optional trailing <small> and up/down color. */
function metric(label: string, main: string, sub?: string, trend?: "up" | "down"): HTMLElement {
  const mc = el("div", "mc")
  mc.appendChild(el("div", "mk", label))
  const v = el("div", "mv")
  v.appendChild(el("span", trend === "up" ? "up" : trend === "down" ? "dn" : undefined, main))
  if (sub) {
    v.appendChild(document.createTextNode(" "))
    v.appendChild(el("small", undefined, sub))
  }
  mc.appendChild(v)
  return mc
}

function metricGrid(items: HTMLElement[]): HTMLElement {
  const grid = el("div", "metrics")
  for (const it of items) grid.appendChild(it)
  return grid
}

/** One comparison delta as a colored chip; null delta → skipped. `betterWhenUp` decides
 *  which direction is green (valid ratio/time up = good; drift count up = bad). */
function deltaChip(label: string, value: number | null, unit: (v: number) => string, betterWhenUp: boolean): HTMLElement | null {
  if (value == null) return null
  const rounded = Math.round(value * 1000) / 1000
  if (rounded === 0) return el("span", "dchip flat", `${label} ±0`)
  const up = rounded > 0
  const good = up === betterWhenUp
  return el("span", `dchip ${good ? "good" : "bad"}`, `${label} ${up ? "▲" : "▼"}${unit(Math.abs(rounded))}`)
}

function deltaChips(d: ComparisonDelta): HTMLElement {
  const wrap = el("div", "cmp-chips")
  const chips = [
    deltaChip("유효율", d.okRatioDelta, (v) => `${Math.round(v * 100)}%p`, true),
    deltaChip("집중", d.validMsDelta, (v) => formatDurationKo(v), true),
    deltaChip("딴짓", d.driftVisitsDelta, (v) => `${Math.round(v)}`, false),
  ]
  for (const chip of chips) if (chip) wrap.appendChild(chip)
  return wrap
}

/** A Catmull-Rom smoothed path through the series (x = progress 0→100, y in [3,37] with
 *  padding so the eased curve can overshoot without clipping). */
function smoothCurvePath(series: number[]): string {
  const pts = series.map((s, i) => [
    (i / (series.length - 1)) * 100,
    3 + (1 - Math.max(0, Math.min(100, s)) / 100) * 34,
  ])
  if (pts.length < 2) return ""
  const d = [`M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`]
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d.push(`C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`)
  }
  return d.join(" ")
}

/** A time-normalized overlay of this / previous / average immersion S curves. */
function sCurveChart(now: number[], last: number[] | null, avg: number[] | null): HTMLElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("class", "scurve")
  svg.setAttribute("viewBox", "0 0 100 40")
  svg.setAttribute("preserveAspectRatio", "none")
  const curve = (series: number[], color: string, width: string, dashed: boolean): void => {
    if (series.length < 2) return
    const path = document.createElementNS(SVG_NS, "path")
    path.setAttribute("d", smoothCurvePath(series))
    path.setAttribute("fill", "none")
    path.setAttribute("stroke", color)
    path.setAttribute("stroke-width", width)
    path.setAttribute("stroke-linejoin", "round")
    path.setAttribute("stroke-linecap", "round")
    path.setAttribute("vector-effect", "non-scaling-stroke")
    if (dashed) path.setAttribute("stroke-dasharray", "3 3")
    svg.appendChild(path)
  }
  if (avg) curve(avg, "#aaa", "1.5", true)
  if (last) curve(last, "#8a8a90", "1.5", false)
  curve(now, "#2b9e57", "2.5", false)
  return svg as unknown as HTMLElement
}

// --- per-card renderers (return the boxed card, or null when there's nothing to show) ---

function cardMischief(r: SessionReport): HTMLElement {
  const { box, body } = card("🙈 딴짓 리포트")
  if (r.driftVisits === 0) {
    body.appendChild(el("div", "none", "딴짓 없이 완주 🎉"))
    return box
  }
  const m = el("div", "mischief")
  m.appendChild(el("b", undefined, `${r.driftVisits}번`))
  m.appendChild(el("span", "u", "들락거림"))
  m.appendChild(el("span", "sep", "·"))
  m.appendChild(el("b", undefined, formatDurationKo(r.driftMs)))
  m.appendChild(el("span", "u", "샜어요"))
  body.appendChild(m)
  const maxVisits = Math.max(1, ...r.topDriftHosts.map((h) => h.visits))
  const ranks = el("div", "ranks")
  for (const h of r.topDriftHosts) {
    ranks.appendChild(rankRow(h.label, (h.visits / maxVisits) * 100, `${h.visits}번 · ${formatDurationKo(h.ms)}`, true))
  }
  body.appendChild(ranks)
  return box
}

function cardHighlight(r: SessionReport): HTMLElement | null {
  if (!r.mvp && !r.villain) return null
  const { box, body } = card("🏅 하이라이트")
  const hl = el("div", "hl")
  if (r.mvp) {
    const c = el("div", "hlc mvp")
    c.appendChild(el("div", "hk", "MVP"))
    c.appendChild(el("div", "hn", r.mvp.title || r.mvp.host))
    c.appendChild(el("div", "hs", `${formatDurationKo(r.mvp.ms)} 집중`))
    hl.appendChild(c)
  }
  if (r.villain) {
    const c = el("div", "hlc vil")
    c.appendChild(el("div", "hk", "빌런"))
    c.appendChild(el("div", "hn", r.villain.label))
    c.appendChild(el("div", "hs", `${formatDurationKo(r.villain.ms)} 헌납`))
    hl.appendChild(c)
  }
  body.appendChild(hl)
  return box
}

function cardSites(r: SessionReport): HTMLElement | null {
  if (!r.siteBars.length) return null
  const { box, body } = card("🕒 사이트별 시간")
  const maxMs = Math.max(1, ...r.siteBars.map((h: HostSlice) => h.ms))
  const ranks = el("div", "ranks")
  for (const h of r.siteBars) {
    ranks.appendChild(rankRow(h.label, (h.ms / maxMs) * 100, formatDurationKo(h.ms), h.verdict === "DRIFT"))
  }
  body.appendChild(ranks)
  return box
}

function cardCompare(title: string, d: ComparisonDelta | null): HTMLElement | null {
  if (!d) return null
  const { box, body } = card(title)
  body.appendChild(deltaChips(d))
  return box
}

function cardSCurve(r: SessionReport, c: SessionComparison): HTMLElement | null {
  if (r.sCurve.length < 2 || (!c.lastSCurve && !c.avgSCurve)) return null
  const { box, body } = card("📉 몰입 곡선 · 이번 vs 지난")
  body.appendChild(sCurveChart(r.sCurve, c.lastSCurve, c.avgSCurve))
  const legend = el("div", "scurve-legend")
  legend.appendChild(makeLegend("lg-now", "이번"))
  if (c.lastSCurve) legend.appendChild(makeLegend("lg-last", "지난"))
  if (c.avgSCurve) legend.appendChild(makeLegend("lg-avg", "평균"))
  body.appendChild(legend)
  return box
}

function makeLegend(cls: string, label: string): HTMLElement {
  const span = el("span", cls)
  span.appendChild(el("i"))
  span.appendChild(document.createTextNode(label))
  return span
}

function cardMetrics(title: string, items: Array<HTMLElement | null>): HTMLElement | null {
  const present = items.filter((x): x is HTMLElement => x != null)
  if (!present.length) return null
  const { box, body } = card(title)
  body.appendChild(metricGrid(present))
  return box
}

function trendLabel(t: "up" | "down" | "flat"): { text: string; trend?: "up" | "down" } {
  if (t === "up") return { text: "↑ 올라감", trend: "up" }
  if (t === "down") return { text: "↓ 흔들림", trend: "down" }
  return { text: "유지" }
}

function renderCard(id: CardId, summary: SessionSummary): HTMLElement | null {
  const r = summary.report
  const c = summary.comparison
  switch (id) {
    case "compare-last":
      return cardCompare("📊 지난번보다", c.vsLast)
    case "compare-avg":
      return cardCompare("📈 최근 평균 대비", c.vsAvg)
    case "scurve":
      return cardSCurve(r, c)
    case "mischief":
      return cardMischief(r)
    case "highlight":
      return cardHighlight(r)
    case "sites":
      return cardSites(r)
    case "focus":
      return cardMetrics("🎯 집중", [
        r.longestFocusMs > 0 ? metric("최장 집중 연속", formatDurationKo(r.longestFocusMs)) : null,
        r.timeToFirstDriftMs != null ? metric("첫 딴짓까지", formatDurationKo(r.timeToFirstDriftMs)) : metric("첫 딴짓까지", "딴짓 없음"),
        metric("방문한 사이트", `${r.distinctHosts}곳`),
      ])
    case "recovery":
      return cardMetrics("🔁 딴짓 회복", [
        r.avgDriftEpisodeMs != null ? metric("딴짓 후 복귀", `평균 ${formatDurationKo(r.avgDriftEpisodeMs)}`) : null,
        r.longestDriftMs > 0 ? metric("한 번 빠지면", formatDurationKo(r.longestDriftMs)) : null,
      ])
    case "rhythm": {
      const half = r.secondHalfTrend ? trendLabel(r.secondHalfTrend) : null
      return cardMetrics("🎚️ 리듬", [
        half ? metric("후반 집중력", half.text, undefined, half.trend) : null,
        r.driftClock ? metric("딴짓 시계", r.driftClock === "early" ? "초반에" : r.driftClock === "mid" ? "중반에" : "후반에") : null,
      ])
    }
    case "goalcard": {
      const goal =
        r.goalMinutes != null && r.goalMinutes > 0
          ? metric(
              "목표 대비",
              `${Math.round((r.activeMinutes / r.goalMinutes) * 100)}%`,
              `${r.goalMinutes}→${r.activeMinutes}분`,
              r.activeMinutes >= r.goalMinutes ? "up" : "down",
            )
          : null
      const ending = r.ending
        ? metric("세션 마무리", r.ending === "OK" ? "유효로 ✓" : "딴짓 중", undefined, r.ending === "OK" ? "up" : "down")
        : null
      return cardMetrics("📌 목표", [goal, ending])
    }
    case "gauge":
      return cardMetrics("📶 게이지", [
        r.lowestS != null ? metric("몰입 최저점", `${r.lowestS}점`) : null,
        r.awayCount > 0 ? metric("자리 비움", `${r.awayCount}번`) : null,
      ])
    default:
      return null
  }
}

function renderReport(summary: SessionSummary): void {
  sumReportEl.replaceChildren()
  for (const id of summary.cards) {
    const box = renderCard(id, summary)
    if (box) sumReportEl.appendChild(box)
  }
}

function showSummary(summary: SessionSummary): void {
  view = "summary"
  currentSummary = summary
  summaryView.hidden = false
  activeView.hidden = true
  setupView.hidden = true
  collapseComment()
  renderReport(summary)

  const stats = summary.stats
  sumGoalEl.textContent = stats.goalText
  if (stats.pagesTotal > 0) {
    const pct = Math.round((stats.okRatio ?? 0) * 100)
    sumRatioEl.innerHTML = `${stats.pagesOk}/${stats.pagesTotal} <small>· ${pct}%</small>`
    setMeter(sumRatioMeter, pct)
  } else {
    sumRatioEl.innerHTML = "<small>판정된 페이지 없음</small>"
    setMeter(sumRatioMeter, null)
  }

  // Denominator is ACTIVE browsing time, not wall-clock — a goal left open overnight must
  // not read as "54분 / 2012분".
  const activeMs = stats.activeMs
  const timePct = activeMs > 0 ? Math.min(100, Math.round((stats.validMs / activeMs) * 100)) : null
  sumTimeEl.innerHTML = `${formatDurationKo(stats.validMs)} <small>/ ${formatDurationKo(activeMs)}${
    timePct != null ? ` · ${timePct}%` : ""
  }</small>`
  setMeter(sumTimeMeter, stats.pagesTotal > 0 ? timePct : null)

  sumNagsEl.textContent = `${stats.nagCount}회`

  const top = stats.topPage
  if (top) {
    sumTopWrap.hidden = false
    sumTopTitleEl.textContent = top.title || top.host
    const ok = top.verdict === "OK"
    sumTopDot.classList.toggle("bad", !ok)
    // textContent (not innerHTML): title/host are page-controlled strings.
    sumTopMetaEl.textContent = `${ok ? "유효" : "이탈"} · ${top.host} · ${formatDurationKo(top.ms)}`
  } else {
    sumTopWrap.hidden = true
  }
  renderComment(summary)
}

// --- event wiring -----------------------------------------------------------------

startButton.addEventListener("click", async () => {
  const rawMinutes = minutesInput.value.trim()
  const minutes = rawMinutes ? Number.parseInt(rawMinutes, 10) : null
  await chrome.runtime.sendMessage({
    type: "set-goal",
    goal: goalInput.value,
    // Only a positive budget is meaningful; a 0/negative would poison the gauge config.
    minutes: minutes != null && Number.isFinite(minutes) && minutes > 0 ? minutes : null,
  })
  view = "setup" // leaving the summary implicitly once a new goal starts
  render(await getState())
})

editButton.addEventListener("click", showSetup)
pauseButton.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: isPaused(current) ? "resume" : "pause" })
  } catch {
    // SW not ready / no receiver — fall through and re-render from the current state.
  }
  render(await getState())
})
endButton.addEventListener("click", async () => {
  let summary: SessionSummary | null = null
  try {
    const res = (await chrome.runtime.sendMessage({ type: "end-session" })) as {
      summary?: SessionSummary | null
    }
    summary = res?.summary ?? null
  } catch {
    summary = null
  }
  if (summary) showSummary(summary)
  else render(await getState())
})
sumMoreButton.addEventListener("click", () => {
  if (commentRevealed) collapseComment()
  else revealComment()
})
summaryView.addEventListener(
  "wheel",
  () => {
    if (view === "summary") revealComment()
  },
  { passive: true },
)
sumDoneButton.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "dismiss-session-summary" })
  } catch {
    // dismissal is cosmetic; still leave the view
  }
  currentSummary = null
  showSetup()
})
for (const id of ["openSettings", "openSettings2"]) {
  document.getElementById(id)?.addEventListener("click", () => chrome.runtime.openOptionsPage())
}

// Startup: shows the summary again when the popup was closed mid-recap (or before 확인).
void (async () => {
  const [state, summary] = await Promise.all([getState(), getSummary()])
  current = state
  if (!state?.goal && summary && !summary.seen) showSummary(summary)
  else render(state)
})()

// Poll the pending recap on a tighter cadence than the gauge refresh, so it surfaces
// promptly once the LLM lands (generation starts eagerly at 종료; this only cuts the
// display lag). Runs regardless of whether 더보기 is open, so the text is ready on reveal.
setInterval(async () => {
  if (view !== "summary" || currentSummary?.comment.status !== "pending") return
  const summary = await getSummary()
  if (summary && summary.epoch === currentSummary.epoch) {
    currentSummary = summary
    if (commentRevealed) renderComment(summary)
  }
}, 600)

// Live update every 1.5s: refresh S while the gauge shows.
setInterval(async () => {
  if (view === "summary") return
  if (activeView.hidden) return
  const state = await getState()
  if (!state?.goal) return
  current = state
  renderActive(state)
}, 1500)

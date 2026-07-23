// In-extension replay page. Reads the event log straight from the IndexedDB SSOT (same
// origin as the service worker) or an imported JSONL, and runs the pure replay engine.

import { getEvents, type KibitzerEvent } from "../lib/events.ts"
import { extractObserves, replayGauge, tauSweep, type ObserveRecord } from "../lib/replay.ts"

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const results = $<HTMLDivElement>("results")
const gaugeCard = $<HTMLDivElement>("gaugeCard")
const srcEl = $<HTMLElement>("src")
const sweepBody = $("sweep").querySelector("tbody") as HTMLTableSectionElement
const sweepNote = $<HTMLElement>("sweepNote")
const gaugeSlider = $<HTMLInputElement>("gauge")
const gTau = $<HTMLElement>("gTau")
const nagCountEl = $<HTMLElement>("nagCount")
const chart = $<HTMLCanvasElement>("chart")

let observes: ObserveRecord[] = []

const TAUS: number[] = []
for (let t = 0.45; t <= 0.751; t += 0.02) TAUS.push(Math.round(t * 100) / 100)

function parseJsonl(text: string): KibitzerEvent[] {
  const events: KibitzerEvent[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const o = JSON.parse(trimmed)
      if (o && typeof o.ts === "number" && typeof o.type === "string") {
        events.push({ ts: o.ts, type: o.type, data: o.data ?? {} })
      }
    } catch {
      // skip
    }
  }
  return events
}

function load(events: KibitzerEvent[], label: string): void {
  observes = extractObserves(events)
  const span = observes.length ? Math.round((observes.at(-1)!.ts - observes[0].ts) / 60_000) : 0
  srcEl.textContent = `${label} · 관측 ${observes.length}개 · ${span}분`
  if (observes.length === 0) {
    results.hidden = gaugeCard.hidden = true
    return
  }
  renderSweep()
  results.hidden = gaugeCard.hidden = false
  renderGauge()
}

function renderSweep(): void {
  const rows = tauSweep(observes, TAUS)
  const maxDrift = Math.max(...rows.map((r) => r.drift), 1)
  sweepBody.innerHTML = rows
    .map((r) => {
      const cur = Math.abs(r.tau - 0.59) < 1e-9 ? ' class="cur"' : ""
      const w = Math.round((r.drift / maxDrift) * 100)
      return `<tr${cur}><td>${r.tau.toFixed(2)}</td><td>${r.ok}</td><td>${r.drift}</td><td>${r.flips}</td></tr>`
    })
    .join("")
  sweepNote.textContent = "'뒤집힘' = 그 tau의 Tier-0 판정이 기록된 판정과 달라지는 관측 수. 강조 행 = 현재 기본값 0.59."
}

function renderGauge(): void {
  const tau = Number(gaugeSlider.value)
  gTau.textContent = tau.toFixed(2)
  const replay = replayGauge(observes, tau, null)
  nagCountEl.textContent = String(replay.nagCount)
  drawChart(replay.series, replay.nagTimes)
}

function drawChart(series: Array<{ ts: number; s: number }>, nagTimes: number[]): void {
  const ctx = chart.getContext("2d")
  if (!ctx || series.length === 0) return
  const W = (chart.width = chart.clientWidth * devicePixelRatio)
  const H = (chart.height = 160 * devicePixelRatio)
  ctx.clearRect(0, 0, W, H)
  const t0 = series[0].ts
  const t1 = series.at(-1)!.ts || t0 + 1
  const x = (t: number): number => ((t - t0) / (t1 - t0 || 1)) * W
  const y = (s: number): number => H - (s / 100) * H
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#1e7a4c"
  // nag markers
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--err") || "#bf4540"
  ctx.lineWidth = devicePixelRatio
  for (const t of nagTimes) {
    ctx.beginPath()
    ctx.moveTo(x(t), 0)
    ctx.lineTo(x(t), H)
    ctx.stroke()
  }
  // S line
  ctx.strokeStyle = accent.trim() || "#1e7a4c"
  ctx.lineWidth = 2 * devicePixelRatio
  ctx.beginPath()
  series.forEach((p, i) => (i === 0 ? ctx.moveTo(x(p.ts), y(p.s)) : ctx.lineTo(x(p.ts), y(p.s))))
  ctx.stroke()
}

$<HTMLButtonElement>("loadDb").addEventListener("click", async () => {
  srcEl.textContent = "불러오는 중…"
  load(await getEvents(), "현재 기록")
})
$<HTMLButtonElement>("pickFile").addEventListener("click", () => $<HTMLInputElement>("file").click())
$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  load(parseJsonl(await file.text()), file.name)
})
gaugeSlider.addEventListener("input", renderGauge)

// Auto-load the current session on open.
void getEvents().then((events) => load(events, "현재 기록"))

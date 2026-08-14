// Offline replay CLI — run OUTSIDE the extension (no browser, no DB). Feed it an exported
// event log (popup/options → "이벤트 JSON" → ~/Downloads/kibitzer-events.jsonl) and it
// re-runs the recorded session under a tau_ok sweep using the same pure engine the
// extension uses (lib/replay.ts).
//
//   node --experimental-strip-types tools/replay.ts <events.jsonl> [availableMinutes]
//
// This is how Claude (or you) tune the detector against real sessions instead of live.

import { readFileSync } from "node:fs"

import { extractObserves, extractPresence, replayGauge, tauSweep } from "../src/lib/replay.ts"
import type { KibitzerEvent } from "../src/lib/events.ts"

function parseJsonl(text: string): KibitzerEvent[] {
  const events: KibitzerEvent[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj.ts === "number" && typeof obj.type === "string") {
        events.push({ ts: obj.ts, type: obj.type, data: obj.data ?? {} })
      }
    } catch {
      // skip malformed line
    }
  }
  return events
}

function bar(n: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0
  return "█".repeat(filled) + "·".repeat(width - filled)
}

function sparkline(series: Array<{ s: number }>): string {
  const glyphs = "▁▂▃▄▅▆▇█"
  if (series.length === 0) return ""
  const step = Math.max(1, Math.floor(series.length / 60))
  let out = ""
  for (let i = 0; i < series.length; i += step) {
    const s = series[i].s
    out += glyphs[Math.min(7, Math.max(0, Math.round((s / 100) * 7)))]
  }
  return out
}

const path = process.argv[2]
if (!path) {
  console.error("usage: node --experimental-strip-types tools/replay.ts <events.jsonl> [availableMinutes]")
  process.exit(1)
}
const availableMinutes = process.argv[3] ? Number(process.argv[3]) : null

const events = parseJsonl(readFileSync(path, "utf8"))
const observes = extractObserves(events)
const presence = extractPresence(events)

console.log(`\nKibitzer replay — ${path}`)
console.log(`events: ${events.length}   observations (scored): ${observes.length}`)
if (observes.length === 0) {
  console.log("no scored observations to replay.")
  process.exit(0)
}
const spanMin = Math.round((observes[observes.length - 1].ts - observes[0].ts) / 60_000)
console.log(`span: ${spanMin} min   availableMinutes: ${availableMinutes ?? "—"}`)

const taus: number[] = []
for (let t = 0.45; t <= 0.751; t += 0.02) taus.push(Math.round(t * 100) / 100)

const sweep = tauSweep(observes, taus)
const maxDrift = Math.max(...sweep.map((p) => p.drift))
console.log("\ntau   OK  DRIFT  flips  drift")
for (const p of sweep) {
  const mark = p.tau === 0.59 ? " *" : "  "
  console.log(
    `${p.tau.toFixed(2)}${mark} ${String(p.ok).padStart(3)} ${String(p.drift).padStart(5)} ${String(p.flips).padStart(5)}  ${bar(p.drift, maxDrift)}`,
  )
}
console.log("  (* = current default; flips = Tier-0 verdict differs from the recorded one)")

console.log("\ngauge re-run (degraded, LLM-free) — nags per tau")
for (const tau of [0.5, 0.55, 0.59, 0.65, 0.7]) {
  const r = replayGauge(observes, tau, availableMinutes, presence)
  console.log(`tau ${tau.toFixed(2)}: ${String(r.nagCount).padStart(3)} nags   S ${sparkline(r.series)}`)
}
console.log("")

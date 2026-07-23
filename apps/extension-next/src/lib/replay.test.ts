import assert from "node:assert/strict"
import test from "node:test"

import { extractObserves, replayGauge, tauSweep } from "./replay.ts"
import type { KibitzerEvent } from "./events.ts"

const ev = (ts: number, type: string, data: Record<string, unknown>): KibitzerEvent => ({ ts, type, data })

test("extractObserves keeps scored observes and sorts by ts", () => {
  const events: KibitzerEvent[] = [
    ev(200, "observe", { pageKey: "b", score: 0.8, tier0: "OK" }),
    ev(100, "observe", { pageKey: "a", score: 0.2, tier0: "DRIFT" }),
    ev(150, "nag", { pageKey: "a" }),
    ev(120, "observe", { pageKey: "c", tier0: "OK" }), // no score → dropped
  ]
  const obs = extractObserves(events)
  assert.deepEqual(obs.map((o) => o.pageKey), ["a", "b"])
})

test("tauSweep counts OK/DRIFT and flips vs recorded tier0", () => {
  const obs = [
    { ts: 1, pageKey: "a", score: 0.7, tier0: "OK" },
    { ts: 2, pageKey: "b", score: 0.5, tier0: "OK" },
    { ts: 3, pageKey: "c", score: 0.3, tier0: "DRIFT" },
  ]
  const [low, high] = tauSweep(obs, [0.4, 0.6])
  assert.deepEqual({ ok: low.ok, drift: low.drift }, { ok: 2, drift: 1 }) // 0.7,0.5 ok
  assert.equal(low.flips, 0) // matches recorded (OK,OK,DRIFT)
  assert.deepEqual({ ok: high.ok, drift: high.drift }, { ok: 1, drift: 2 }) // only 0.7 ok
  assert.equal(high.flips, 1) // b (0.5) flips OK→DRIFT
})

test("replayGauge nags on sustained drift and never on all-OK", () => {
  const okSession = [
    { ts: 0, pageKey: "a", score: 0.9, tier0: "OK" },
    { ts: 20 * 60_000, pageKey: "a", score: 0.9, tier0: "OK" },
  ]
  assert.equal(replayGauge(okSession, 0.59, null).nagCount, 0)

  // A long strict drift on a tight time budget drains S to 0 → at least one nag.
  const driftSession = [
    { ts: 0, pageKey: "yt", score: 0.1, tier0: "DRIFT" },
    { ts: 40 * 60_000, pageKey: "yt", score: 0.1, tier0: "DRIFT" },
  ]
  const replay = replayGauge(driftSession, 0.59, 10)
  assert.ok(replay.nagCount >= 1, `expected a nag, got ${replay.nagCount}`)
  assert.ok(replay.series.length > 0)
})

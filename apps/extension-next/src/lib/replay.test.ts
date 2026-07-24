import assert from "node:assert/strict"
import test from "node:test"

import { extractObserves, extractPresence, presentAt, replayGauge, tauSweep } from "./replay.ts"
import type { KibitzerEvent } from "./events.ts"

const ev = (ts: number, type: string, data: Record<string, unknown>): KibitzerEvent => ({ ts, type, data })

test("extractPresence pulls sorted boolean transitions and ignores the rest", () => {
  const events: KibitzerEvent[] = [
    ev(300, "presence", { present: true }),
    ev(100, "presence", { present: false }),
    ev(200, "observe", { score: 0.5 }),
    ev(150, "presence", { present: 5 }), // non-boolean → ignored
  ]
  assert.deepEqual(extractPresence(events), [
    { ts: 100, present: false },
    { ts: 300, present: true },
  ])
})

test("presentAt follows the transitions and assumes present before the first / with none", () => {
  const p = [
    { ts: 100, present: false },
    { ts: 200, present: true },
  ]
  assert.equal(presentAt(p, 50), true) // before the first transition
  assert.equal(presentAt(p, 150), false) // during the away stretch
  assert.equal(presentAt(p, 250), true) // after returning
  assert.equal(presentAt([], 999), true) // no presence data → back-compat present
})

test("replayGauge does not drain S while the user was away (B7 presence-aware)", () => {
  const t0 = 1_000_000
  const observes = [
    { ts: t0, pageKey: "a", score: 0.2, tier0: "DRIFT" }, // drifting page
    { ts: t0 + 40 * 60_000, pageKey: "a", score: 0.2, tier0: "DRIFT" }, // 40 min later
  ]
  const active = replayGauge(observes, 0.59, null) // no presence → assume present the whole gap
  const away = replayGauge(observes, 0.59, null, [{ ts: t0 + 1000, present: false }]) // away right after t0
  assert.ok(active.nagCount > 0, "an active 40-min drift nags")
  assert.equal(away.nagCount, 0, "an away 40-min gap does not nag")
})

test("replayGauge sorts presence defensively — unsorted input yields the same result", () => {
  const t0 = 1_000_000
  const observes = [
    { ts: t0, pageKey: "a", score: 0.2, tier0: "DRIFT" },
    { ts: t0 + 40 * 60_000, pageKey: "a", score: 0.2, tier0: "DRIFT" },
  ]
  const sorted = replayGauge(observes, 0.59, null, [
    { ts: t0 + 1000, present: false },
    { ts: t0 + 20 * 60_000, present: true },
  ])
  const shuffled = replayGauge(observes, 0.59, null, [
    { ts: t0 + 20 * 60_000, present: true },
    { ts: t0 + 1000, present: false },
  ])
  assert.equal(sorted.nagCount, shuffled.nagCount, "presence order must not change the outcome")
})

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

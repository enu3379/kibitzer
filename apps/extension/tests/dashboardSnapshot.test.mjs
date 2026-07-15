import assert from "node:assert/strict"
import test from "node:test"

import { completeDashboardSnapshot } from "../src/popup/dashboardSnapshot.ts"

function dashboardState() {
  return {
    session_id: "session-1",
    has_goal: true,
    tracking: "tracking",
    controller_type: "alignment",
    streak: 0,
    streak_threshold: 3,
    obs_count: 4,
    coldstart_observations: 3,
  }
}

function currentSession(goalText = "Write the release notes") {
  return {
    session: {
      id: "session-1",
      created_at: "2026-07-16T00:00:00Z",
      active: true,
    },
    goal: {
      session_id: "session-1",
      raw_text: goalText,
      provenance: "declared",
      updated_at: "2026-07-16T00:00:00Z",
      available_time_minutes: 90,
    },
  }
}

function sessionStats(observations = 4) {
  return {
    session_id: "session-1",
    started_at: "2026-07-16T00:00:00Z",
    duration_seconds: 120,
    observations,
    ok: 3,
    drift: 1,
    unjudged: 0,
    interventions: 1,
    interventions_accepted: 1,
    top_drift_count: 1,
  }
}

test("partial dashboard failures preserve the last good offline snapshot", () => {
  const good = completeDashboardSnapshot(
    dashboardState(),
    currentSession(),
    sessionStats(),
  )
  assert.ok(good)

  for (const [current, stats] of [
    [null, sessionStats()],
    [currentSession(), null],
  ]) {
    let storedSnapshot = good.snapshot

    const degraded = completeDashboardSnapshot(dashboardState(), current, stats)
    if (degraded) storedSnapshot = degraded.snapshot

    assert.equal(degraded, null)
    assert.deepEqual(storedSnapshot, good.snapshot)
  }
})

test("normal refresh returns a complete replacement snapshot", () => {
  const updated = completeDashboardSnapshot(
    dashboardState(),
    currentSession("Review pull requests"),
    sessionStats(8),
  )

  assert.ok(updated)
  assert.equal(updated.snapshot.goalText, "Review pull requests")
  assert.equal(updated.snapshot.stats.observations, 8)
  assert.equal(updated.availableTimeMinutes, 90)
})

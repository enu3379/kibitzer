# Handoff — Gauge track B (Python), shadow-first

You are the **B track** of a two-track build. A (TypeScript) is the migration destination;
you (Python) are the early real-data probe on the current server. Read these first, in order:

1. `docs/gauge/contract.md` — the **binding** language-neutral contract (events, state,
   effects, dynamics, Tier 2 gates, renag, celebration). This is the spec you implement.
2. `docs/gauge-dual-track.md` — how the two tracks stay in lockstep. Note: **A owns the
   fixtures; you consume them.** Never change gauge behavior without a fixture that pins it.
3. `docs/analysis-plan-a-gauge-design.md` §1–§6 — the design rationale behind the contract.
   §9 (the old Python stage roadmap) is **superseded**; follow this handoff instead.
4. `docs/planning-notes.md` D9 — locked decisions: S recovers to 100; degraded mode weights
   both directions by f(margin); plan B (`streak`) is not a design constraint; `J_page = 0`.

## Your branch and environment

- Work in this worktree only: `/Users/eunu03/kibitzer-worktrees/gauge-python` (branch
  `feature/gauge-py-shadow`, based on the shared contract commit).
- Tests: `/Users/eunu03/kibitzer/.venv/bin/python -m pytest apps/server/tests -q`
  (the worktree has no venv of its own; use the shared one). Baseline before you start:
  319 passed, 1 skipped — keep it green.
- Extension build is not yours. Do not touch `apps/extension/`.

## Milestone B1 (do this first, stop at the end for review)

Deliver a **pure Python gauge reducer** validated against the shared fixtures. Nothing else.

1. `apps/server/app/core/controllers/gauge.py`:
   - `GaugeState`, `GaugeConfig`, `GaugeEvent` (tagged union), `GaugeEffect`, `GaugeTransition`
     as dataclasses matching contract §2–§4 field-for-field (same names, snake_case is fine —
     see the field-name mapping note below).
   - `reduce_gauge(state, event, config) -> GaugeTransition` — **pure**: no clock, DB, network,
     logging side effects. "Now" is only `event.ts` (epoch ms). Implement dynamics exactly as
     contract §5–§6, including operation order (inertia → accel transition → integrate).
2. `apps/server/tests/test_gauge_fixtures.py`:
   - Auto-discover and load every `fixtures/gauge/*.json` (repo-root relative), replay each
     through `reduce_gauge`, and assert `expected` per the runner semantics in
     `fixtures/gauge/README.md` (golden `final_state`, property `assert`, `effects_contain` =
     union of effects across all events, float compare within `tolerance`).
   - All current fixtures must pass. `01-*` (golden) pins exact `s`/`m`; if you cannot make it
     pass, your dynamics or op-order is wrong — do not edit the fixture.

**Field-name mapping:** fixture JSON uses camelCase keys (`activeVerdict`, `accelTier`,
`rDrain`, `tauM`, `tUp`…). Load them into snake_case dataclass fields via an explicit
key map in the test loader (and a `from_json`/`to_json` on the dataclasses). Do not rename
the JSON — it is shared byte-for-byte with the TS track.

## Milestone B2 (only after B1 is reviewed and approved)

Interim **shadow** wiring on the Python server — records S/m/accelTier, still no real nags:
- `gauge_states` table (SQLite) + persistence, separate from `controller_states`.
- Feed the reducer from existing signals: the observation verdict (`ingest.py`) as a `nav`
  event, and presence heartbeats (`observations.py` presence handler) as `heartbeat`/`inactive`.
  The gauge derives dwell from its own event timestamps — **do not** change the existing
  `drift_page_dwell_states` / clock behavior, and do not remove the OK-heartbeat early return.
- Expose S in `/sessions/current/state` behind a shadow field. Existing `streak` controller
  keeps nagging. All existing tests stay green.

## Milestone B3 (separate, after B2) — real-data trigger + validation

Wire the gauge as the actual trigger under an opt-in flag, run real sessions, and report
findings. Each finding you want to change becomes a **new failing fixture** proposed back to
the A/contract owner (do not edit existing fixtures or the contract yourself) — see the sync
protocol in `docs/gauge-dual-track.md`.

## Rules

- **Do not invent semantics.** If the contract is silent or a fixture case is missing, stop
  and write your question/assumption into `docs/handoff-gauge-python-shadow-notes.md` (append,
  timestamped) rather than guessing. The A owner reconciles.
- Keep the reducer pure and the placeholder knobs only in `GaugeConfig`.
- Do not modify `streak`/`alignment` controllers or change the shipped default controller.
- Conventional Commit messages; end commit bodies with the repo's Co-Authored-By trailer.
- Report status by appending to `docs/handoff-gauge-python-shadow-notes.md`: what you built,
  test results (paste the pytest summary line), and open questions.

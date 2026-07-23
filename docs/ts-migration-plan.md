# Kibitzer TS / serverless migration plan

Status: **v0.2, 2026-07-23.** Canonical execution plan for the whole refactor. Supersedes
the Python stage roadmap in `docs/analysis-plan-a-gauge-design.md` §9. Decision record:
`docs/planning-notes.md` **D9**. Single forward track: **TypeScript only**.

## 0. TL;DR — where we are

The **gauge decision core is built, validated, and wired in persistent shadow mode** — a pure
TypeScript reducer, independently cross-checked against a throwaway Python reducer (byte-identical
over the shared fixtures and a lifecycle benchmark). The extension feeds server verdicts and its
local presence clock into that reducer. IndexedDB is now the gauge SSOT: each checkpoint and its
new effects commit in one transaction, with effects retained in a pending outbox. The developer
popup can inspect S and outbox state, but no effect can be delivered. This document is the map from
that durable shadow to "one TypeScript runtime in the extension, Python server removed."

## 1. Goal — end-state architecture

```
Chrome events → TS Tier 0 (WASM embeddings) → TS Tier 1 (Ollama) → TS Gauge
              → TS Tier 2 (Ollama) → notification
```

Everything runs inside the MV3 extension. The Python FastAPI server is **removed**. The
gauge is the real attention trigger. No local server process, no HTTP round-trips on the hot path.

## 2. Foundational decisions

- **No A안 / B안 going forward.** The old controllers — A안 = 누적이탈 (`AlignmentController`,
  cumulative-drift EWMA) and B안 = 연속이탈 (`StreakController`, consecutive-drift streak) — are
  **dropped as designs.** The single **immersion-gauge decision core** built this cycle is *the*
  controller. `StreakController` survives only as the current shipping default until the Python
  server is removed; it is not a design constraint.
- **TypeScript only.** The Python reducer (`gauge.py`) existed **solely to check the design runs
  correctly when executed** — it did, byte-identical to TS. It is now a frozen reference; **no
  Python wiring is built** (no `gauge_states`, no server shadow, no Python trigger). All wiring
  work is in the extension.
- **Gauge semantics are frozen** as the v0 contract: `docs/gauge/contract.md` (§1–§6 of
  gauge-design). Numeric knobs are §8 placeholders until D4 calibration. The Python stage roadmap
  (gauge-design §9: `gauge.py`, `gauge_states`, all-page dwell in `observations.py`) is **not
  built** — the TS gauge derives dwell from its own heartbeat clock.

## 3. Current status — done & verified

| Piece | State |
|---|---|
| Language-neutral contract + fixtures (`docs/gauge/contract.md`, `fixtures/gauge/`) | ✅ 4 fixtures (golden + property) |
| **TS gauge reducer** (`apps/extension/src/core/gauge/`) | ✅ pure `reduceGauge`, tests + typecheck green |
| Design-runs-correctly cross-check (Python `gauge.py`) | ✅ byte-identical over fixtures + 61-step benchmark (`max|ΔS|=0`) — **purpose fulfilled, frozen** |
| Recovery curve (issue #122 "F") | ✅ adopted |
| Extension shadow runner | ✅ server verdicts + local heartbeat |
| IndexedDB gauge SSOT | ✅ checkpoint + pending effects in one transaction |
| Phase 2 state migration | ✅ one-time `chrome.storage.session` → IndexedDB import |
| Popup diagnostics | ✅ S/m/accel/outbox state behind the existing developer toggle |
| Effect delivery | ⬜ intentionally disabled; existing Python controller remains authoritative |
| Pushed / PR'd | ✅ Phase 1 merged; Phase 2 is #125; Phase 3 is the stacked migration PR |

The pure core, shadow wiring, and durable persistence boundary are complete. TS providers are next.

## 4. Phased roadmap (TypeScript, independent PRs → `dev-migrate`)

- **Phase 1 — Pure core (✅ done).** Reducer + fixtures + benchmark.
- **Phase 2 — Shadow mode (✅ done).** The extension service worker consumes server Tier 0/1
  verdicts + local presence heartbeats as gauge events. It serializes `reduceGauge` transitions,
  and initially used `chrome.storage.session` for its diagnostic snapshot. The popup exposes
  S/m/acceleration/effect state only when developer diagnostics are enabled. **Effects are
  recorded, not delivered** — the existing controller keeps nagging.
- **Phase 3 — IndexedDB SSOT (✅ done).** IndexedDB owns the checkpoint and pending-effect outbox.
  Reducer state and newly emitted effects commit in one transaction; memory advances only after
  the commit succeeds. It survives MV3 worker/browser restarts, migrates the Phase 2 session
  snapshot once, clears on goal replacement/session end/activity deletion, and keeps only a
  bounded diagnostic view while retaining the full pending outbox. Delivery remains disabled.
- **Phase 4 — Providers to TS (next).** Port Tier 0 (WASM embeddings) and the Ollama Tier 1/2 calls into
  the extension runtime.
- **Phase 5 — Cutover.** Switch the gauge to the real trigger, remove the Python server and
  `StreakController`. `dev-migrate` merges to `main`.
- **D4 calibration (parallel).** Replay-CLI tuning of the §8 knobs against logged sessions; gates
  the shipped defaults, not the wiring.

## 5. Branch & merge model

- **Forward line:** `migrate/<slug>` → long-lived integration branch **`dev-migrate`** → `main` at
  cutover. Never squash `dev-migrate`.
- **Frozen:** `feature/gauge-py-shadow` (Python reducer) — a completed validation artifact, not a
  moving track. It is deleted with the Python server.
- Shared fixtures (`fixtures/gauge/`) are the regression suite; a semantics change is fixture-first.

## 6. Open decisions

1. **Ship timing → RESOLVED (2026-07-22):** the gauge stays shadow until the TS cutover — **no
   interim Python trigger.** (The Python track was validation-only.)
2. **#117 long wall-clock gap** — Phase 2 rebases the reducer clock on both inactive and active
   presence transitions, so inactive wall time is not integrated. Any additional return-time
   relaxation of m / tier / episode remains a calibration decision; S is unchanged on return.

## 7. Document map

| Doc | Role |
|---|---|
| `docs/analysis-plan-a-redesign.md` | historical: plan-A analysis §1–§2 (problems P1–P10). §3–§5 superseded. |
| `docs/analysis-plan-a-gauge-design.md` | gauge **algorithm/semantics** rationale. §1–§6 valid; **§7 (B안) and §9 (Python roadmap) are obsolete** — this plan replaces §9. |
| `docs/gauge/contract.md` | binding, language-neutral behavior contract the reducer satisfies. |
| `docs/gauge-dual-track.md` | historical: how the TS + Python reducers were kept in lockstep to validate the core. The dual track is finished; work is now TS-only. |
| **`docs/ts-migration-plan.md`** (this) | canonical execution plan for the whole refactor. |
| `docs/planning-notes.md` D9 | the decision record. |

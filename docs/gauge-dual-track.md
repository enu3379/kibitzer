# Gauge dual-track workflow (A = TypeScript, B = Python)

Status: **completed 2026-07-22.** Historical record of how the two pure reducers
were built in parallel and kept in lockstep. The Python track stopped after
cross-validation; its real-data shadow/trigger plan below was superseded by
`docs/ts-migration-plan.md` and planning-notes **D9**. The branch & merge model
remains the landing procedure for the frozen artifacts.

## Why two tracks

- **A (TypeScript)** is the *destination*. Endgame = full serverless refactor (Tier 0
  WASM + Ollama Tier 1/2 + Gauge in the extension, Python server removed). The gauge is
  built once in TS to avoid re-porting.
- **B (Python)** is the *early real-data probe*. It ships the gauge on the current Python
  server so we can validate the v0 semantics against real browsing **now**, long before
  the migration lands. B is deliberately throwaway: it is deleted with the Python server.
- Both are worth it only because they share one contract. Every real-data lesson B learns
  becomes a fixture that permanently improves A.

## The linchpin: one contract, two implementations

- `docs/gauge/contract.md` — language-neutral spec (events, state, effects, dynamics).
- `fixtures/gauge/*.json` — golden + property fixtures. **Both** test runners load the
  **same files**. This is what makes "fix A and B together" mechanical rather than manual.
- **A owns the fixtures.** The TS reducer is the reference; fixtures are authored on the
  A/contract side. B consumes them and must pass byte-identical files.
- A contract change is a three-step commit, in order: (1) update `contract.md` + fixture,
  (2) make A pass, (3) make B pass. Never change one implementation's behavior without a
  fixture that pins it.

## Branch & merge model

| Track | Working branches | Target | Lifetime |
|---|---|---|---|
| **Contract/foundation** | `feature/gauge-contract` | `dev` | shared base for both tracks |
| **B (Python)** | `feature/gauge-py-<slug>` | `dev` (squash, Conventional Commits) | until Python server removal |
| **A (TypeScript)** | `migrate/<slug>` | **`dev-migrate`** (long-lived integration line) | migration line; `dev-migrate` → `main` at cutover |

Rules layered on the repo baseline (`AGENTS.md`):

1. `dev-migrate` is the TS/serverless integration line — a `dev`-parallel long-lived branch.
   It merges **`dev` into itself regularly** (to inherit B's fixture fixes and shared code)
   and merges to **`main` only at cutover** (when the gauge becomes the real trigger and the
   Python server is deleted). Never squash `dev-migrate`.
2. B follows the normal repo flow unchanged: `feature/gauge-py-*` → `dev`, squash-merge, PR
   title = Conventional Commit, AI-assisted box checked.
3. The shared contract (`contract.md` + `fixtures/`) lands on **`dev`** so both lines inherit
   it. Until that PR merges, A and B branch from the contract branch as their base.
4. `gh` PR creation may be blocked in-session (sandbox); `git push` works. Prepare branches +
   commits locally; open PRs with `gh pr create` (retry) or the user runs `! gh pr create`.

## Sync protocol (when B's real data finds a problem)

1. Reproduce as a **failing fixture** (golden if exact, property if qualitative) on the
   contract branch. This is the bug report.
2. Update `contract.md` if the semantics (not just a knob) changed.
3. Fix **A** to pass → commit on `migrate/<slug>`.
4. Fix **B** to pass → commit on `feature/gauge-py-<slug>`.
5. Knob-only changes (§8 placeholders) never touch code — only fixture `config` blocks +
   regenerated golden values. Semantics changes touch `contract.md` + both reducers.

CI gate (both tracks): the fixture suite must be green. A: `npm run test` (Node built-in
runner, `--experimental-strip-types`). B: `pytest apps/server/tests/test_gauge_fixtures.py`.

## Roles this cycle

- **This session (Claude)** drives **A**: contract, fixtures, TS reducer, shadow wiring,
  popup debug S.
- **Opus subagent** drives **B**: Python reducer passing the shared fixtures, then interim
  trigger wiring + real-data run. Work order: `docs/handoff-gauge-python-shadow.md`.
- On a real-data finding, both are updated in the same sync cycle (above).

## Shadow-first for both

Neither track sends real nags until its own SSOT is authoritative. A stays shadow until the
migration cutover. B may flip to a real trigger earlier (that is its purpose — the D9 "ship
timing" question), but only once its reducer passes the full fixture suite and its state is
persisted (SQLite `gauge_states`). Until then B also runs shadow (records S/m/accel only).

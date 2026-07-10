# Handoff: Replay CLI (per-session deterministic re-simulation)

Date: 2026-07-08
Scope owner: delegated agent (Codex).
Parent plans: [judgment-audit-plan.md](judgment-audit-plan.md) (this tool is its
Step 0/Step 7 prerequisite — everything in that plan is gated on this),
[planning-notes.md](planning-notes.md) D4 (scope decision, resolved 2026-07-08).

## Why this exists

Verdicts are a *state* phenomenon: observation N is judged against the
exemplar/anchor state built through observation N-1. The 나무위키 anchor-hijack
chain (2026-07-08 LG그램 session) is invisible to any r0-only re-scoring — the
failure lives in the state trajectory. So replay must **re-simulate the whole
Tier-0 path**, not reuse stored scores.

This is bounded and feasible because every input is already logged
(observations with timestamps and embeddings, feedback events, page labels,
goal) and the Tier-0 path is deterministic (hash embedding, cosine scoring,
mean anchor). Tier 1/2 are LLMs — their **recorded** verdicts are replayed by
default.

Two consumers, immediately:

1. **Audit Step 0** — a labeling-friendly table of a real session's
   observations (now pre-seeded with D5 popup page labels) from which r0
   histograms per (verdict × label) are built. Thresholds (`tau_ok`,
   `audit_ok_below`, `beta`, `anchor_epsilon`) get chosen from these, not
   guessed.
2. **Counterfactual config/code testing** — replay yesterday's session under a
   candidate config (or after a detection change) and diff verdicts against
   what actually happened.

## What replay re-runs (the deterministic path)

Per observation, in original timestamp order, mirroring
`POST /observations/browser-nav` in
[observations.py](../apps/server/app/api/observations.py):

1. **Title-furniture strip** — `strip_repeated_title_suffix(embedding_text,
   recent_titles_for_host(host))`. The recent-titles state is cross-session
   ("any session", last 10 by ts) — reproduce it exactly with a ts-bounded
   query against the log DB: titles of observations with `(ts, id) <
   (obs.ts, obs.id)` on that host, any session, newest 10. Prior same-session
   titles are replay-invariant (titles are inputs), so this is exact.
2. **Embedding** — re-embed the stripped text via the configured embedding
   provider (hash_cpu today — deterministic). Do NOT reuse stored
   `features.emb`: normalization changes must propagate into new embeddings.
3. **Tier 0 score** — `tier0_score_parts(emb, exemplars, anchor, beta)` +
   `r0 >= tau_ok` verdict, using the **replayed** exemplar/anchor state (see
   below), with all config values from the replay config.
4. **Tier 1 (recorded by default)** — see the tier policy section.
5. **Anchor admission** — recompute `anchor_eligible` with the same rule as
   live (`exemplar_score >= anchor_epsilon` or LLM-vetted OK).
6. **Controller** — feed the replayed verdict into the same
   `StreakController`/`AlignmentController` via `apply_controller`, with `now
   = obs.ts` (refactor note below). Record would-be `request_excerpt` actions.

### Replayed state (in memory, never written to the DB)

- **Exemplars** — start from the goal seed (embed the goal `raw_text` at the
  `goal.declared` event; equivalently `goal_exemplars` position 0), then apply
  each `goal.exemplar_added` event from `event_log` at its timestamp: the
  event payload carries `observation_id` — take that observation's replayed
  embedding (recompute; do not use its stored one). This single event stream
  covers both `related` feedback and D5 `related` page labels, in order.
  Re-apply the exemplar cap with the same rule as
  `_enforce_goal_exemplar_cap` (cap from replay config).
- **Anchor** — mean of the last `anchor_window` replayed-OK embeddings whose
  replayed `anchor_eligible` is not False (mirror `recent_ok_embeddings` +
  `anchor_value`), maintained in memory from replayed verdicts.
- **Controller state** — in-memory `ControllerStateRecord` equivalent, updated
  per observation; `snooze`/`break` feedback rows apply `snoozed_until` at
  their `ts` exactly as the feedback API does.

Interleave the event timeline (observations + feedback + labels) by timestamp
so state mutations land between the same observations as they did live.

**Counterfactual caveat (accepted, from the audit plan):** user actions
(feedback clicks, labels) are replayed as ground truth at their timestamps
even where the replayed pipeline would have judged the page differently, and
real browsing would have changed after a different intervention.
Detection-layer metrics are the reliable output; intervention counts are
indicative only. Print this caveat in the report footer.

## Tier 1/2 policy

- **Default: replay recorded verdicts.** An observation has a recorded Tier-1
  result iff `tier_reached >= 1` (then `observations.verdict` is the Tier-1
  verdict and `tier1_reason` its reason; `tier1.classified` events carry the
  same). Tier-2 outcomes come from `tier2.confirmed` / `tier2.cancelled`
  events. Excerpts are not stored (privacy) — Tier 2 can never be re-called
  from the log; it is replayed as recorded outcome or counted as
  "would request excerpt".
- **Missing recordings are first-class, not errors.** When the replayed
  routing consults Tier 1 where the original run did not (different Tier-0
  verdict today; audit-OK routing after audit-plan Step 4), keep the replayed
  Tier-0 verdict, tag the row `tier1: no_recording`, and count these in the
  summary ("Tier 1 would be called N times; M had no recording"). Threshold
  tuning needs this uncertainty band visible.
- **`--live-tiers` (optional flag, off by default):** re-call Tier 1 live via
  the runtime providers for rows lacking recordings (requires
  `configs/models.local.yaml`). Cache responses in a sidecar JSON next to the
  output (keyed by observation id + payload hash) so reruns are stable and
  free. Never cache into the source DB. This flag may ship as a follow-up if
  it inflates the patch.

## CLI shape

Package: `apps/server/app/replay/` (importable core + `__main__.py`), run as
`python -m apps.server.app.replay`. Core functions must be usable from tests
without the CLI.

```text
python -m apps.server.app.replay \
  --db ./data/kibitzer.sqlite3 \          # default: replay config's server.db_path
  --session sess_f249ac14 \               # id or unique prefix; --latest for newest ended+goal session
  --config configs/default.yaml \         # replay config (defaults like the server)
  --override relevance.tau_ok=0.2 \       # repeatable dotted-path override (threshold-tuning loop)
  --csv out/replay-sess_f249ac14.csv \    # labeling table (optional)
  --json out/replay-sess_f249ac14.json \  # machine-readable diff (optional)
  --live-tiers                            # optional; see tier policy
```

`--list-sessions` prints id / created_at / goal / observation count and exits.

Notes:

- **The source DB is read-only.** Open it `mode=ro` (SQLite URI) or read
  everything up front; acceptance includes a byte-identity check. All replay
  state is in memory; outputs go to stdout/files only.
- Config comes from the CLI only — the live pipeline's runtime-settings
  overrides (`effective_controller_config`) are deliberately NOT read from the
  DB settings table; replaying under a chosen config is the whole point.
  Document this in `--help`.
- No wall-clock anywhere: every "now" is the observation/event timestamp.

## Output

**Stdout (human):**

1. Header: session id, goal text, observation count, config deltas vs
   defaults (print every `--override`).
2. Per-observation diff table (only rows where anything changed, plus
   `--full` to print all): `ts · host · title (truncated) · r0 orig→replay ·
   verdict orig→replay · tier orig→replay · flags` (flags: `flip`,
   `tier1:no_recording`, `anchor:admitted|blocked`).
3. Summary block: verdict flips by direction (OK→DRIFT, DRIFT→OK), unchanged
   count; Tier-1 calls original vs replayed-would-call vs no-recording;
   `request_excerpt` actions original vs replayed; text histogram of replayed
   r0 in 0.05 buckets split by replayed verdict, and — where page labels
   exist — by (verdict × label) with a false-OK / false-DRIFT count
   (label='drift' & verdict=OK, label='related' & verdict=DRIFT).
4. Counterfactual caveat footer.

**CSV (audit Step 0 labeling table)** — one row per observation:

```text
ts, url_host, title, r0_orig, r0_replay, exemplar_score_replay,
anchor_score_replay, anchor_eligible_replay, verdict_orig, verdict_replay,
tier_orig, tier_replay, tier1_reason, page_label, hand_label, title_quality
```

`page_label` is the D5 popup label if present; `hand_label` and
`title_quality` are empty columns reserved for hand labeling (title_quality
gets auto-filled once audit-plan Step 2 ships its classifier).

**JSON** mirrors the CSV rows plus the summary block, for future tooling.

## Required small refactor

`apply_controller` ([controller_flow.py](../apps/server/app/core/controller_flow.py))
calls `datetime.now(timezone.utc)` internally — add an optional `now:
datetime | None = None` parameter (default preserves live behavior) so replay
can inject `obs.ts`. Also give the replay module its own in-memory
store-equivalent for the controller state rather than threading a fake
`SQLiteStore` through — whichever is smaller; do not change live behavior.

If any other helper on this path reaches for the wall clock or writes to the
store, refactor it the same way (inject, don't monkeypatch). Everything else
(`strip_repeated_title_suffix`, `tier0_score_parts`, controller classes,
embedding provider) is already pure or injectable.

## Edge cases

- Observations with no goal at their time (pre-`goal.declared`): no verdict
  live; replay skips scoring the same way and keeps them out of stats (count
  them in a header note).
- `observation.dropped` (sensitive-domain) rows never became observations —
  invisible to replay; fine.
- Legacy rows missing `anchor_eligible`/`exemplar_score` (pre-2026-07-08):
  original-side fields may be blank in the diff; replayed side is always
  complete.
- Goal re-declared mid-session (`set_current_goal` wipes exemplars): follow
  the `goal.declared` events — reset replayed exemplars to the new seed at
  that timestamp.
- Same-timestamp events: order by `(ts, event_log.id)`; observations vs
  events at identical ts follow live insertion order (event ids are
  monotonic).

## Validation invariant (the harness's own correctness test)

A session recorded under the **current** code, replayed under the **same**
config, must reproduce stored results exactly: identical verdicts and
`tier_reached`, `r0`/`exemplar_score` equal within 1e-9, identical
`anchor_eligible`. Fresh post-2026-07-08 sessions (e.g. the 마인크래프트
validation session) satisfy this; sessions recorded before the drift fixes
will legitimately diverge — that divergence is the tool working (the 나무위키
chain must replay as DRIFT under current code, mirroring
`test_drift_fixes.py`).

## Acceptance

- New tests (pytest, alongside existing suites), all offline/deterministic:
  1. Round-trip invariant: build a synthetic session through the API test
     client (navs + related feedback mid-session), replay with the same
     config → zero diffs, r0 within tolerance.
  2. Threshold counterfactual: same fixture replayed with `--override
     relevance.tau_ok` flips the expected rows and only those.
  3. Exemplar timeline: a `related` feedback (or page label) mid-session
     changes replayed scores only for subsequent observations.
  4. Tier-1 recorded replay + `no_recording` tagging both exercised.
  5. Read-only guarantee: source DB file hash unchanged by a replay run.
- `--list-sessions`, default replay, `--csv`, and one `--override` verified
  against the real dogfood DB by hand (document the command in progress.md).
- Existing suites stay green; extension untouched.
- progress.md entry.

## Non-goals

- No plotting/graphing dependencies — CSV + text histograms only.
- No new detection behavior (audit-plan Steps 1–6 come after this, measured
  by this).
- No negative-exemplar scoring (deferred by D4 until replay + labels show
  need).
- No delivery simulation (personas, quiet hours, celebrations, toasts).
- No cross-session learning of any kind (D4: session-scoped memory only).
- No writes to the source DB, ever (including `--live-tiers` caching).

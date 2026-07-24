# Handoff: Tier-0 OK Audit Routing + Title Quality (audit plan Steps 2–5)

Date: 2026-07-09 (original spec) / 2026-07-20 (re-implementation notes)
Implementation status: **RE-IMPLEMENTED as PR #115 (2026-07-20)** — the notes
below were the work order for that PR and stay as its rationale. Outstanding
after #115: the private-corpus recalibration of `audit_ok_below` (provisional
0.7 from the public benchmark-v2 sweep) via the env-gated regression in
`test_audit_routing.py`.
Original status: The feature was
completed and regression-verified 2026-07-10 on the local branch
`feature/judgment-review` (commit `30076c2`, superset of
`feature/tier0-audit-routing`) but was never PRed; `dev` has since moved
through the ONNX Tier-0 provider (#29), the ingest extraction (#83), the D7
time-budget path (#49), the Tier-2 Judge/Writer split (`331a0ba`), goal
revisions (#86), and the D8 label-override boundary (#67). Use `30076c2` as a
reference implementation — do **not** rebase it.
Scope owner: delegated agent (Codex). Threshold recalibration needs the
private corpus (`KIBITZER_AUDIT_CORPUS` / `KIBITZER_AUDIT_DB`) — coordinate
with the user for the fixtures.
Parent plans: [judgment-audit-plan.md](judgment-audit-plan.md) Steps 2–5,
[planning-notes.md](planning-notes.md) backlog item 3.

## Re-implementation notes (2026-07-20) — read before the original spec

1. **Integration point moved.** Tier-0 → Tier-1 flow now lives in
   `apps/server/app/core/ingest.py` (verdict set around `:93`, Tier-1 hook at
   `:96-110` via `build_tier1_payload`), not `api/observations.py`. Audit
   routing extends the `verdict == OK` side of that exact hook, before the
   controller/D7 accrual — an audited OK→DRIFT flip must feed drift clocks
   identically to a native Tier-0 DRIFT.
2. **Every threshold below is hash-era — recalibrate, do not copy.** The
   original numbers (`audit_ok_below: 0.35`, the 7-false-OK coverage set,
   27/110 fresh-audit volume) were measured when Tier 0 was the hash embedder
   with `tau_ok = 0.15`. Today Tier 0 is KoEn-E5-Tiny ONNX with
   `tau_ok = 0.6` (real-corpus operating point τ≈0.42–0.45; see
   `docs/benchmarks/tier0-embedding-v2/` and the 2026-07-13 progress entries).
   First re-derive the surviving-false-OK set and the audit band on the
   ONNX-replayed corpus with D3 phrases injected, then re-run the volume sweep
   (the *shape* of the acceptance — full coverage of surviving false-OKs at
   ≤ 30% fresh-audit volume — stands; the constants do not).
3. **The Tier-1 reliability prerequisite is already done.** `think: false`
   handling and output-budget-exhaustion classification landed with the
   Judge/Writer split and #108; drop that patch item from the original spec.
4. **Replay is rewritten, but the columns are waiting.** `ReplayRow` already
   carries `hand_label`, `title_quality`, and `tier1_would_call`
   (`apps/server/app/replay/core.py:97-100`) with CSV columns wired — fill
   them from the real routing instead of adding new plumbing, and mirror the
   window/reuse logic per the original replay-parity section.
5. **Exemplar-skip guardrail meets newer label semantics.** `record_page_label`
   now has `sync_exemplar` (record-only review labels, #113) and D8 makes
   labels the effective product verdict (#67). The title-quality exemplar
   skip (original Feature A, guardrail 2) is a third, distinct rule: the
   label/feedback is recorded and still drives the effective verdict, but a
   generic/url_like/empty-titled observation must not enter the exemplar set;
   surface `exemplar_added: false` in the response.
6. **Observability is free.** The judgment-review dashboard (#113) already
   renders `title_quality` / `audit_trigger` / `audit_cached` chips and an
   감사됨 filter as soon as those keys appear in `features_json` — no UI work
   in this handoff.
7. Evidence base: the private Step-0 corpus (231 hand-labeled rows incl.
   `title_quality`) plus the 2026-07-13 double-labeled fifth session (260 rows
   pooled) via `KIBITZER_AUDIT_CORPUS`; D3 simulation results in
   [handoff-goal-enrichment.md](handoff-goal-enrichment.md).

---

The original 2026-07-09/10 spec follows. File paths, thresholds, and counts in
it are pre-ONNX and pre-refactor; the notes above override them where they
conflict.

## Why now, with numbers

After D3, the labeled corpus has **7 surviving false-OKs** (Tier-0 view,
enriched full simulation). Trigger coverage is four `low_margin`, two
`low_quality_title`, and one `mixed_host`; the raw browsing titles stay in the
private fixture.

**Union = 7/7.** Every remaining labeled false-OK gets a Tier-1 review, which
now judges with `goal.derived_phrases` context (D3 feature 2). Cost side from
Step 0: auditing OKs under 0.35 touches ~27% of true-OKs; generic-title
true-OKs add a few more — measure the real volume in acceptance, expect ≤30%.

**Live confirmation (2026-07-09 dogfood):** three deliberately constructed
near-miss searches shared the goal's surface tokens and scored 0.348, 0.696,
and 0.426, so Tier 0 called all three OK; the user drift-labeled each in the
popup. The lowest-score case is covered by `low_margin`; the two higher-score
cases are covered by `mixed_host` because the same host family already had a
DRIFT. The local session remains the live 3/3 regression case without exposing
its identifier or page titles here.

**Prerequisite note — Tier-1 output reliability:** the same session logged
`tier1.provider_error` ×3 (JSONDecodeError ×2, ReadTimeout ×1) and a
`tier2.provider_error` (JSONDecodeError) within ~4 minutes. Symptom matches
the enrichment bug fixed 2026-07-09: nemotron's thinking exhausts the shared
`num_predict` (tier1 320 / tier2 640) and returns EMPTY content, which no
lenient parser can save. Audit routing multiplies Tier-1 call volume, so
apply the same fix to `classify_tier1`/`confirm_tier2` in this patch:
`think: false` + the existing max_output_tokens as the content budget
(fallback without the flag for models that reject it, mirroring
`complete_goal_enrichment`). This should also cut the known ~17%
ReadTimeout rate (backlog item 4).

## Feature A — title quality classifier (Step 2)

New `apps/server/app/core/title_quality.py`:

```python
def classify_title(text: str) -> Literal["content_specific", "generic", "url_like", "empty"]
```

Input is the **furniture-stripped** embedding text (same string the pipeline
embeds). Heuristic principles (tune freely — the benchmark below is the
contract, not the exact rules):

- `empty`: nothing left after stripping/whitespace.
- `url_like`: looks like a URL/path/query rather than prose — scheme or
  `www.`, multiple `/` or `?`/`&`/`=`/`%xx`, or one long dotted token,
  digit/symbol-dominated.
- `generic`: platform/navigation furniture rather than content — ≤ 1
  content-bearing token after stripping, or the whole title is in a small
  navigation lexicon (로그인, 고객지원, 검색결과, 메시지, 홈, 설정,
  Settings, Usage, Sign in, …) or a bare brand/platform name.
- `content_specific`: everything else.

**Benchmark (required):** the Step-0 CSVs carry hand `title_quality` for all
231 rows. Add a test that runs the classifier over them (re-derive the
stripped text the same way the replay does) and prints the confusion matrix;
hard-assert ≥ 80% agreement on the content_specific-vs-generic axis and zero
`content_specific` misclassifications of hand-labeled `url_like`/`empty`
rows. If the heuristic can't reach the bar, stop and surface the matrix
instead of forcing it.

### Quality wiring (guardrails, same feature)

1. **Anchor admission**: observations whose title quality is
   generic/url_like/empty are `anchor_eligible = False`, overriding every
   other path (including Tier-1-vetted OK — audit plan Step 9: generic
   titles must not steer the anchor).
2. **Exemplar learning**: `related` feedback/page-label on a low-quality
   title records the feedback/label + event exactly as today but **skips
   `add_goal_exemplar_from_observation`**. Response objects gain
   `exemplar_added: bool` so the popup can say so honestly (popup copy is a
   Claude follow-up — just ship the field).
3. Persist `title_quality` on observation features (dev card + replay CSV
   get it for free).

## Feature B — Tier-0 OK audit routing (Steps 3–5)

Config:

```yaml
judgment_audit:
  enabled: true
  audit_ok_below: 0.35
  audit_low_quality_titles: true
  audit_mixed_hosts: true
  risk_hosts: []        # config backstop, ships empty; the plan's starter
                        # list can be adopted after live volume is known
```

In `/observations/browser-nav`, after the Tier-0 verdict and BEFORE the
controller, when `verdict == OK` and a Tier-1 provider is available and any
trigger fires:

- `low_margin`: `r0 < audit_ok_below`
- `low_quality_title`: quality ∈ {generic, url_like, empty} (and
  `audit_low_quality_titles`)
- `mixed_host`: the current **host family** already has both OK and DRIFT
  observations in this session (`audit_mixed_hosts`). Host family =
  host with a leading `www.`/`m.`/`search.`/`news.`-style subdomain
  stripped to the registrable-ish suffix — keep it a simple prefix-strip
  helper, no PSL dependency.
- `risk_host`: host family ∈ `risk_hosts`

Audit call = the existing Tier-1 path with audit metadata added to the
payload (audit plan Step 7 shape):

```json
{"audit": {"trigger": "low_margin|low_quality_title|mixed_host|risk_host",
            "tier0_score": 0.234}}
```

Semantics:

- Tier-1 DRIFT → observation verdict becomes DRIFT, `tier_reached = 1`,
  reason persisted; flows into the controller as drift (Tier 2 still only
  after the controller asks — privacy boundary unchanged).
- Tier-1 OK → verdict stays OK, `tier_reached = 1` (vetted; anchor-eligible
  unless the title-quality override applies).
- Tier-1 error/timeout → keep the Tier-0 OK, record the provider error
  (same best-effort contract as today's DRIFT-side Tier 1).
- Persist the fired trigger in features (`audit_trigger`) and in events.

Prompt: extend both judges' Tier-1 system prompts with the audit-mode
sentence (same platform ≠ related; a user exemplar is an example, not a
domain-wide permission — wording already in audit plan Step 7). Keep the
strict binary JSON contract; no `uncertain`.

## Replay parity (required, same patch)

`_replay_observation` must mirror the routing exactly: recompute
title quality + triggers, reuse recorded Tier-1 verdicts when the original
run audited the same observation, and tag `tier1:no_recording` when the
replayed routing audits where the original didn't (this will be common on
pre-routing sessions — it is the honest accounting, not an error). Add
`title_quality` and `audit_trigger` columns to the replay CSV/JSON.

## Acceptance

- Corpus replay (D3 phrases injected via `--derived-phrases`, routing
  enabled): **all 7 surviving labeled false-OKs fire a trigger** (assert the
  set), and the measured audit volume over hand-labeled `related` tier0-OK
  rows is reported and ≤ 30%.
- Title-quality benchmark test vs the 231 hand labels (bar above).
- Unit tests: each trigger fires/doesn't fire; audited-OK vs audited-DRIFT
  semantics incl. controller flow; quality overrides on anchor admission;
  related-feedback/label on generic title records but skips exemplar
  (`exemplar_added` false); mixed-host family normalization; replay parity
  on a synthetic session (pipeline decisions == replayed decisions).
- Existing suites green; progress.md entry.

## Follow-up (specified 2026-07-09, implemented 2026-07-10): meet the ≤30% volume bar

First implementation measured **97/110 (88%)** related Tier-0 OK rows audited —
`mixed_host` alone contributed 55 and, on the corpus, uniquely catches nothing
(all 7 false-OKs are covered by low-margin/low-quality routes); its value is
the two higher-score live escapees. Narrowing variants were swept on the
private corpus plus live session (2026-07-09):

| variant | audited related | two live high-score cases |
|---|---|---|
| current (any prior family DRIFT) | 97/110 = 88% | O O |
| M=10min drift-recency window | 59/110 = 54% | O O |
| broad + page-dedup | 38/110 = 35% | O O |
| **M=10min window + page-dedup (chosen)** | **27/110 = 25%** | **O O** |

r0-cap variants lose the 0.696 case — rejected. Spec for the chosen shape:

1. **`judgment_audit.mixed_host_window_minutes: 10`** — `mixed_host` fires
   only if the host family had a DRIFT observation within the window
   (family-scoped, ts-based; SQL on observations).
2. **Per-page audit reuse, not re-audit** — before calling Tier 1 for an
   audit, look up the latest observation in this session with the same
   (host_family, title) that already carries an `audit_trigger` and
   `tier_reached >= 1`: reuse its verdict/reason (persist
   `audit_trigger`, mark features e.g. `audit_cached: true`, no Tier-1
   call). No new table — the observations table already holds outcomes.
   The two "missed" rows in the dedup simulation are exactly such revisits
   and inherit the first audit's outcome, so coverage stays 7/7 + 3/3.
3. Replay parity for both (window + reuse), CSV/JSON columns included.
4. Acceptance update: corpus fresh-audit volume ≤ 30% (measured 25%),
   coverage sets unchanged (7/7 corpus via fresh-or-cached, live 3/3).

The implemented regression replays the private source DB with injected D3
phrases and asserts 7/7 routed false-OKs plus exactly 27/110 fresh audits.
The private CSV/DB fixtures are supplied through `KIBITZER_AUDIT_CORPUS` and
`KIBITZER_AUDIT_DB`; they are intentionally not committed to this public repo.

Also queued from review: `title_quality.py` leans on corpus-memorized exact
lists (`_GENERIC_EXACT`, brand special-cases) — fine as a starting point but
the benchmark's ≥80% is partially memorized, not generalization; prefer
structural rules when touching it next (no new hand-list growth).

## Non-goals

- No negative exemplars (still D4-deferred), no `uncertain` verdict, no
  Tier-2 routing changes, no metadata-bundle collection (audit plan's
  og:title idea stays future), no popup UI/copy changes (Claude follow-up:
  dev-card rows for `derived_score`/`title_quality`/`audit_trigger` and the
  exemplar-skipped label copy).

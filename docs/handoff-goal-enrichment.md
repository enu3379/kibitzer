# Handoff: D3 Goal Enrichment (cross-lingual derived exemplars)

Date: 2026-07-09
Scope owner: delegated agent (Codex).
Parent plans: [judgment-audit-plan.md](judgment-audit-plan.md) §"Add Goal
Enrichment" (Step 1), [planning-notes.md](planning-notes.md) D3 (design
resolved 2026-07-09). The evidence/eval corpus contains real browsing history
and stays local; set `KIBITZER_AUDIT_CORPUS` to its directory when rerunning
the optional regression.

## Why (measured, not hypothesized)

Step-0 labeling (231 real observations) showed Tier 0's dominant failure is
**false-DRIFT: 80/142 related pages score under τ**, mostly because the goal
string's vocabulary cannot reach the pages' vocabulary — cross-lingual
(Korean goal "마인크래프트 크리에이트모드" vs English titles → r0 = 0.000)
and sub-topic words (압출기, 배낭 펌프, 서비스센터). No τ value fixes a
0.00-mass. The consequence is also operational: 58–100% of observations
would call Tier 1 (network LLM, ~17% timeout), because Tier 0 absorbs
almost nothing.

Fix: at goal declaration, ONE cheap LLM call derives K short phrases that
related page titles would literally contain; they are embedded locally and
matched at Tier 0. Pre-flight eval with hand-drafted phrases over the
private labeled corpus (fixture: `$KIBITZER_AUDIT_CORPUS/derived-phrases-eval.json`):

| derived_tau | false-DRIFT fixed (of 80) | NEW false-OK |
|---|---|---|
| 0.15 (= tau_ok) | 55 | 7 |
| 0.20 | 54 | 4 |
| **0.25 (chosen)** | **52** | **2** |
| 0.30 | 46 | 1 |
| 0.35 | 41 | 0 |

6 of the 7 new false-OKs at 0.15 are hash-bucket noise (zero real lexical
overlap — e.g. "크리에이트 모드 기차 철도 제작" matching a 5·18 news title at
0.287); with K phrases the max() samples that noise K times, hence the
**separate, higher threshold for derived matches**. The residual 2 at 0.25
score < 0.35, i.e. inside the planned `audit_ok_below` band — Tier-1-audited
once audit-plan Step 5 lands. Enrichment and the audit band are a package:
true positives land high (0.4–0.8), collateral lands in the audited zone.

## Feature 1 — enrichment call + derived exemplars

### Flow

1. `POST /sessions/current/goal` returns as today (seed exemplar unchanged).
   Enrichment then runs **async, fire-and-forget** — never blocks or fails
   goal setting; the coldstart window absorbs the latency.
2. One call on the **Tier-1 cloud provider stack** (same Ollama Cloud
   client/keys/rotation). Only the goal text leaves the machine — never page
   content. Strict-JSON response, validated + post-filtered.
3. Phrases are embedded locally (hash provider, same as titles) and stored
   as **derived exemplars**, separate from click exemplars.
4. Events: `goal.enriched {phrases, provider, latency_ms}` on success,
   `goal.enrichment_failed {error_type}` on any failure (silent skip —
   system behaves exactly as today).

### Prompt (Claude-owned copy — use verbatim, `{goal_text}`/`{max_phrases}` interpolated)

```text
You expand a user's declared browsing goal into short search-style phrases.
The phrases seed a local lexical matcher that decides whether a browser tab
title is related to the goal, so each phrase must read like something that
would literally appear in the title of a related page.

Declared goal (verbatim): "{goal_text}"

Return strict JSON only: {"phrases": ["...", "..."]}

Rules:
- At most {max_phrases} phrases.
- Each phrase 2-6 words, content-bearing, specific to this goal's subject.
- Cover DISTINCT aspects (actions, tools, entities, synonyms, adjacent
  sub-tasks) — not rewordings of one phrase.
- If pages about this topic are commonly in another language (software,
  gaming, tech, research → English), write roughly half the phrases in that
  language.
- NEVER output: bare platform/site names (YouTube, Google, 나무위키, Reddit),
  bare generic activity words (검색, 리뷰, 정리, 공략, tutorial, guide —
  allowed only when tightly bound to a goal-specific noun), or single common
  words.
- Test each phrase: if this phrase alone appeared in a page title, would that
  page almost certainly be about the goal? If not, drop it.

Example — goal "국내 여행지 탐색":
{"phrases": ["국내 여행지 추천 코스", "제주 부산 강릉 여행", "국내 숙소 예약
비교", "당일치기 근교 여행", "domestic Korea travel itinerary"]}
```

### Post-filter (code side, deterministic)

- Parse strict JSON; on parse failure → one retry, then enrichment_failed.
- Truncate to `max_phrases`; drop phrases with < 2 or > 8 whitespace tokens;
  drop exact duplicates and near-duplicates (pairwise cosine > 0.95 between
  phrase embeddings); drop any phrase equal (case-folded) to the goal text.

### Scoring integration (the false-OK guard)

Derived exemplars do NOT join the plain exemplar max. Extend
`tier0_score_parts` (or wrap it) so:

```text
derived_score = max cosine(emb, derived_embs)          # 0.0 if none
r0 = max(exemplar_score,                                # seed + click exemplars (unchanged)
         beta * anchor_score,                           # unchanged
         derived_score if derived_score >= derived_tau else 0.0)
```

- Config: `goal_enrichment: {enabled: true, max_phrases: 8, derived_tau:
  0.25, timeout_seconds: 20}`.
- Persist `derived_score` in observation features (popup dev-card and replay
  diagnostics get it for free).
- **Anchor admission**: extend the rule to
  `exemplar_score >= anchor_epsilon OR derived_score >= derived_tau OR
  (verdict OK AND tier_reached >= 1)`. Derived matches are real goal
  affinity; the noise floor is exactly why the bar is derived_tau, not
  anchor_epsilon.

### Storage

New table (do not reuse `goal_exemplars` — different scoring path, and cap
eviction must not eat the goal's backbone):

```sql
goal_derived_exemplars(id, session_id FK, position, phrase TEXT,
                       vector_json TEXT, created_at)
```

Wiped and rewritten on goal re-declaration (same lifecycle as the seed).

## Feature 2 — derived phrases ride the Tier 1 payload (user proposal 2026-07-09)

Add `goal.derived_phrases: [...]` (the phrase strings, ≤ max_phrases) to
`build_tier1_payload`, and one line to both judge providers' Tier-1 system
prompts: the declared goal *includes these derived aspects; titles matching
them are goal-related even when they share no words with the raw goal*.
This gives the judge the same cross-lingual bridge Tier 0 gets — it
arbitrates exactly the borderline band (derived_tau misses, audit-band
reviews) where vocabulary knowledge matters most. Cheap: a few tokens per
call.

## Replay integration (eval harness)

1. Handle `goal.enriched` events: re-embed the recorded phrases at the
   event's timestamp and set the replayed derived-exemplar state (mirrors
   how `goal.declared` reseeds).
2. New flag `--derived-phrases <path.json>` — injects phrases right after
   `goal.declared` for sessions recorded before D3. The private fixture uses
   `$KIBITZER_AUDIT_CORPUS/derived-phrases-eval.json`
   (`goals.<session_id>.phrases`).
3. `--override goal_enrichment.derived_tau=X` must reach the replayed
   scoring (falls out of AppConfig overrides if config is threaded through).

## Acceptance

- Unit tests: prompt-response validation + post-filter (dedupe, caps,
  parse-failure fallback); derived_tau gating in scoring (below-bar derived
  match contributes 0, above-bar sets r0 and anchor eligibility); enrichment
  failure leaves goal flow untouched; `goal.enriched` replay handling;
  `--derived-phrases` injection round-trip.
- **Corpus regression eval** (deterministic — fixed phrases, fixed labels):
  replay the four private Step-0 sessions with `--derived-phrases
  $KIBITZER_AUDIT_CORPUS/derived-phrases-eval.json` and default config +
  `derived_tau=0.25`; assert against the labeled CSVs: false-DRIFT ≤ 30
  (baseline 80) and NEW false-OKs (vs baseline 9) all have
  `r0 < 0.35`. The pytest runs when `KIBITZER_AUDIT_CORPUS` is set and
  skips otherwise, keeping personal titles, hosts, and timestamps out of the
  public repository while remaining runnable offline.
- Live smoke: declare a goal with the real cloud provider, verify
  `goal.enriched` lands and `/observations/latest` shows `derived_score`
  on a matching page.
- Existing suites green; progress.md entry.

## Non-goals

- No enrichment re-runs mid-session (one shot at goal declaration; goal edit
  = new shot).
- No negative phrases / conflict vocabulary (D4 deferral stands).
- No page content in the enrichment call, ever.
- No popup UI changes in this handoff (derived_score already surfaces via
  the D5 dev card's features once persisted).

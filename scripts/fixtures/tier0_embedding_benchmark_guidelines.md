# Tier 0 Embedding Benchmark Dataset Guidelines

## Purpose

This dataset compares the existing hash embedding with KoEn E5 Tiny ONNX for
Tier 0. Tier 0 is a high-precision `obvious OK` filter: an OK prediction skips
Tier 1, while a non-OK prediction can still be reviewed later. Therefore the
dataset must contain realistic hard negatives, not only easy unrelated titles.

## Required Size And Balance

- Exactly 200 flat anchor-title pairs.
- Exactly 40 distinct anchor groups with exactly 5 titles per anchor.
- Per anchor: exactly 2 `OK` and exactly 3 `DRIFT` labels.
- Overall: exactly 80 `OK` and 120 `DRIFT` pairs.
- At least 24 of the 40 anchors must contain no more than 3 whitespace-separated
  words (eojeol for Korean).
- At least 120 of the 200 titles must contain no more than 6
  whitespace-separated words.
- At least 80 pairs must combine an anchor of at most 3 words with a title of
  at most 6 words.
- The short anchors must include `뉴스`, `컴퓨터 쇼핑`, `등기부등본`, and `코스피`.
- At least 30 anchor groups must include an English `OK` title that directly
  expresses the Korean anchor's meaning.

## Label Meaning

- `OK`: the page title is directly and unambiguously useful for the declared
  goal. Tier 0 should be allowed to accept it without an LLM review.
- `DRIFT`: Tier 0 must not automatically accept it. This includes clearly
  unrelated pages, lexical-overlap traps, different senses of the same word,
  and adjacent or ambiguous topics that deserve later review.

Do not label merely topical or weakly associated titles as `OK`. False OK is
the expensive error in this benchmark.

## Five Titles Per Anchor

Each anchor group should normally contain:

1. One Korean `OK` title with direct semantic relevance but little or no exact
   word overlap with the anchor.
2. One English `OK` title that translates or directly expresses the anchor.
3. One `DRIFT` hard negative that reuses an anchor word in the wrong sense or
   context.
4. One `DRIFT` title from an adjacent but not obviously useful topic.
5. One short, clearly unrelated `DRIFT` title.

The legacy fixture groups already have four titles. Preserve all of those
anchor-title-label combinations and add one useful hard negative to each group
to reach five.

## Legacy Fixture Requirement

Every anchor and candidate from
`scripts/fixtures/onnx_embedding_smoke_cases.json` must appear in the new
dataset without changing its text or semantic label:

- `related` maps to `OK`.
- `unrelated` maps to `DRIFT`.
- Mark these rows with `source: "legacy_fixture"`.

## Content Coverage

Cover a broad range of realistic declared goals, including:

- news and current affairs
- computer/electronics shopping
- public documents and administrative tasks
- finance and stock indices
- programming and technical documentation
- research and study
- travel, weather, food, health, pets, sports, entertainment
- household errands and product searches

Prioritize short titles and short anchors. Include cases where:

- anchor and title are both short;
- title is a synonym, category member, or common paraphrase rather than a token
  copy;
- a Korean anchor is matched by a concise English title;
- a negative title shares a prominent token with the anchor;
- a word has a different everyday or technical meaning;
- a broad anchor such as `뉴스` still has labels that a human can defend.

Avoid URLs, hostnames, fabricated benchmark scores, long explanatory prose,
and titles that reveal their label through words such as `relevant` or
`unrelated`.

## JSON Schema

Write one UTF-8 JSON object with this shape:

```json
{
  "version": 1,
  "pairs": [
    {
      "id": "unique-stable-id",
      "group_id": "stable-anchor-group-id",
      "anchor": "뉴스",
      "title": "오늘의 주요 헤드라인",
      "label": "OK",
      "tags": ["short_anchor", "ko_semantic_no_overlap"],
      "source": "generated",
      "rationale": "Directly presents current news headlines."
    }
  ]
}
```

Required fields for every pair:

- `id`: unique kebab-case identifier.
- `group_id`: shared by exactly five rows with the same anchor.
- `anchor`: declared user goal.
- `title`: realistic browser page title.
- `label`: exactly `OK` or `DRIFT`.
- `tags`: one or more tags from the controlled list below.
- `source`: exactly `generated` or `legacy_fixture`.
- `rationale`: one short English sentence explaining the human label without
  referring to model behavior.

Controlled tags:

- `short_anchor`
- `short_title`
- `ko_semantic_no_overlap`
- `en_translation`
- `cross_lingual`
- `lexical_overlap_trap`
- `different_sense`
- `adjacent_topic`
- `easy_negative`
- `legacy_fixture`

Tagging rules are mechanical where possible:

- Add `short_anchor` to every row whose anchor has at most 3 words, and never
  add it to a longer anchor.
- Add `short_title` to every row whose title has at most 6 words, and never add
  it to a longer title.
- `en_translation` is only for an `OK` row whose title contains an English
  semantic translation or direct English expression of the anchor.
- Every `legacy_fixture` source row must also carry the `legacy_fixture` tag.

## Mechanical Validation

Before finishing, validate all of the following:

- JSON parses as UTF-8.
- `pairs` length is exactly 200.
- IDs are unique.
- Anchor-title pairs are unique.
- There are exactly 40 groups and each group has one anchor and five rows.
- Every group has exactly 2 OK and 3 DRIFT rows.
- There are exactly 80 OK and 120 DRIFT rows overall.
- At least 24 anchors have at most 3 words.
- At least 120 titles have at most 6 words.
- At least 80 rows combine a short anchor and a short title.
- At least 30 groups contain an `en_translation` OK row.
- All 32 legacy fixture rows are present with matching labels.
- Every tag is from the controlled list.
- Mechanical tags match their text lengths and labels.

Do not run either embedding provider while generating or revising labels. The
dataset must be model-independent.

---

# Version 2 (2026-07-13)

`tier0_embedding_benchmark_dataset_v2.json` supersedes v1 for provider and
scoring-rule comparisons. It was rebuilt after replaying the labeled real
corpus (260 observations, 5 real sessions) under the ONNX provider exposed
what v1 could not measure:

- v1 had **zero lexical-overlap OK pairs** (the "≥30 English OK groups" rule
  crowded them out), so it scored hash below random (AUC 0.368) and
  overstated every provider's operating recall at a given tau — v1 predicted
  recall 23.8% at tau 0.6 where the real corpus delivered 9.9%.
- v1 had **no same-frame adjacency traps** — the real corpus showed frame
  siblings ("7월 제철 X" style) passing even tau 0.6 as false-OKs.
- v1 titles were canonical short phrases; real tab titles carry platform
  suffixes, unread-count prefixes, typos, and clickbait phrasings that
  systematically depress cosine scores.

## v2 composition contract (enforced by `_validate_v2_dataset`)

Same structure as v1 (200 pairs, 40 groups × 5, 2 OK : 3 DRIFT, unique
anchor-title pairs, mechanical `short_anchor`/`short_title` tags), plus:

- `source: "v2_generated"` on every pair; tags from `CONTROLLED_TAGS_V2`.
- ≥30 groups with a `lexical_overlap_ok` OK title (restores the common case).
- ≥12 groups with an English OK title (`cross_lingual`, must contain ASCII).
- ≥30 groups with a trap DRIFT (`same_frame_trap` or `lexical_overlap_trap`).
- ≥12 `clickbait_ok` OK titles (on-topic pages with weak surface signal).
- ≥8 `typo_query` titles (misspelled self-search tabs).

Title realism rules: platform suffixes (" - YouTube", " : 네이버 블로그",
" - Google 검색", " · GitHub", " - Stack Overflow", community boards),
"(1) " unread prefixes, occasional bare hub titles (`generic_hub`).

## Slice design (5 × 8 groups)

1. v2g01-08 — everyday goals with lexical-overlap OK titles.
2. v2g09-16 — same-frame adjacency traps (frame shared, topic slot swapped).
3. v2g17-24 — cross-lingual dev/gaming/research goals with realistic English
   titles AND English-drift traps that share the OK vocabulary.
4. v2g25-32 — oblique/clickbait related titles, with traps that look
   lexically closer than the true OK (the inversion case).
5. v2g33-40 — 1-2 word polysemous anchors (이사/백신/비자/물때/이월/등기…)
   whose traps exploit the other word sense.

`goal_enrichment_sim_phrases_v2.json` carries goal-only derived-phrase sets
for every v2 group so the goal-enrichment scoring rule can be compared on the
same pairs (consumer script lands with the goal-enrichment PR).

## What v2 is for (and not for)

- **For**: ranking providers/scoring rules under realistic hard cases, and
  regression-testing that a change doesn't collapse a slice (per-tag recall).
- **Not for**: calibrating the production `tau_ok`. v2 is deliberately
  trap-dense (40/40 groups), so absolute FPR/recall are pessimistic relative
  to live traffic. Calibrate tau on the private labeled real corpus replay
  (see docs/audit runbook); v2 numbers gate rankings, not thresholds.

## Provenance

All 200 v2 pairs are invented (agent-generated 2026-07-13, human-directed;
two-stage validation: mechanical contract + independent adversarial label
audit). No real browsing titles were copied; real-corpus failure modes were
transferred as PATTERNS only. Verified zero verbatim overlap against the
private corpus titles.

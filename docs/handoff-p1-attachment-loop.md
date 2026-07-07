# Handoff P1: Attachment Loop

Date: 2026-07-06
Scope owner: delegated agent (Codex), **execute only after P0 merges** — P0 reshapes
the persona/settings interfaces this stage builds on. Re-verify file states before
starting; this document is interface-level on purpose.
Parent plan: [roadmap-fun-layer.md](roadmap-fun-layer.md)

## Features and interface sketches

### 1. Return celebration (reinforcement over punishment)

- Detect, at observation time, a DRIFT→OK transition where the preceding drift
  stretch lasted ≥ `celebration.min_drift_minutes` (config, default 3).
- Rate-limit hard: at most one celebration per `celebration.cooldown_seconds`
  (default 3600) and never during quiet hours. Celebrations must feel rare.
- Message source: persona `celebrate_templates` (already reserved in the YAML
  schema; content by Claude). No Tier 2 call — templates only, placeholders
  `{return_minutes}` `{goal}`.
- Delivery: reuse the notification path with a distinct event
  `celebration.delivered`; NOT an intervention row (it must not touch streak,
  cooldown, or the pending-intervention card).

### 2. "5분만" — intentional break

- New feedback kind `break` on interventions: snoozes exactly
  `break.duration_seconds` (default 300), marks the intervention `break`,
  records `feedback.recorded` as today.
- When the break expires the controller resumes silently (no "break over" nag in
  v1 — the next drift observation speaks for itself).
- Extension: add the third notification button ("5분만") — note Chrome caps
  buttons at 2, so the button set becomes configurable: `related` + `break`,
  body click stays `accepted`, snooze moves to the popup card only. Confirm the
  final layout with Claude before implementing (copy is Claude-owned).

### 3. Custom personas

- Merge order: `configs/personas.yaml` ← `~/.kibitzer/personas.yaml` (user file
  wins per key; absent file is fine). Validate with the P0 pydantic models;
  invalid entries are skipped with one startup warning each.
- `GET /personas` → list of `{key, name}` for the popup selector.

### 4. Session report data

- `GET /sessions/current/report` → per-hour related-ratio buckets, top 3 drift
  hosts, longest OK stretch (start/end/minutes), intervention/feedback counts.
  Computable from existing `observations` + `interventions` tables; no schema change.
- Daily variant `GET /reports/daily?date=` may reuse ended sessions.

### 5. Judgment transparency

- Persist Tier 1 reason on the observation row (currently only in the event log):
  add nullable `tier1_reason` column via `_ensure_observation_columns`.
- Expose in `pending_intervention` and the report API so the popup can answer
  "왜 이렇게 판단했어?".

## Boundaries

Same ownership table as the roadmap: server plumbing + `background.ts` mechanics
here; popup UI, all Korean copy, and `celebrate_templates` content are Claude's.
Acceptance: pytest green with new tests per feature; extension build green;
progress.md entry.

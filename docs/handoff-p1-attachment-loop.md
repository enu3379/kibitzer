# Handoff P1: Attachment Loop

Date: 2026-07-06 (delivery surface updated 2026-07-08)
Scope owner: delegated agent (Codex), **execute only after P0 merges** — P0 reshapes
the persona/settings interfaces this stage builds on. Re-verify file states before
starting; this document is interface-level on purpose.
Parent plan: [roadmap-fun-layer.md](roadmap-fun-layer.md)

> **2026-07-08 delivery-surface change (already shipped, affects this handoff):**
> the extension now renders interventions as an **in-page toast** injected into
> the drifting tab (`apps/extension/src/content/toastOverlay.ts`, wired in
> `background.ts` `showNotification`), with the old `chrome.notifications` path
> kept only as a fallback for non-injectable pages. Server-side nothing changed:
> `PipelineResult{action: notify}` still drives delivery. Feature 1 and feature 2
> below inherit this surface — details inline.

## Features and interface sketches

### 1. Return celebration (reinforcement over punishment)

- Trigger: a genuine drift-departure → return. The preceding stretch must be a
  *sustained* DRIFT (controller-confirmed drift, not a single borderline
  observation) lasting ≥ `celebration.min_drift_minutes` (config, default 3), and
  the returning observation must be a real OK. Borderline blips must not fire it —
  the user's words: "드리프트 완벽히 이탈 후 복귀를 했을 때만."
- Frequency (Claude-adjusted 2026-07-07): fire on every qualifying return — this
  is the payoff the user wants to feel — but keep a short anti-farm floor
  `celebration.cooldown_seconds` (default 300, was 3600) so a rapid
  drift→return→drift loop cannot spam praise, and never fire during quiet hours.
- Randomness is the anti-staleness mechanism (user-requested): pick uniformly at
  random from the persona's `celebrate_templates`, and never repeat the
  immediately previous celebration line within a session. The pool is
  intentionally ≥ 6 lines per persona.
- Message source: persona `celebrate_templates` (content by Claude). No Tier 2
  call — templates only, placeholders `{return_minutes}` `{goal}`. Note that the
  `quiet_coach` pool deliberately mostly omits `{return_minutes}` (no metrics /
  shame); do not inject counts into it.
- Delivery: reuse the notification path with a distinct event
  `celebration.delivered`; NOT an intervention row (it must not touch streak,
  cooldown, or the pending-intervention card).
- Delivery surface (2026-07-08): celebrations ride the same in-page toast. Add a
  `kind: "celebration"` field to the notify-style result (or a parallel action)
  so `background.ts` can pass a variant flag to `showKibitzerToast`; the toast's
  celebration styling (no feedback buttons, softer auto-dismiss) is Claude-owned —
  wire the flag through and Claude will style it. Fallback system notification
  behaves as today.

### 2. "5분만" — intentional break

- New feedback kind `break` on interventions: snoozes exactly
  `break.duration_seconds` (default 300), marks the intervention `break`,
  records `feedback.recorded` as today.
- When the break expires the controller resumes silently (no "break over" nag in
  v1 — the next drift observation speaks for itself).
- Extension: the in-page toast (2026-07-08) removes Chrome's 2-button cap — the
  toast can hold `related` + `break` + `snooze` if desired. Add the button in
  `toastOverlay.ts` (`data-kind="break"`) and route it in the background
  `kibitzer:toast-feedback` listener. The legacy system-notification fallback
  keeps the 2-button cap: there use `related` + `break`, body click `accepted`.
  Confirm the final layout with Claude before implementing (copy is Claude-owned).

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

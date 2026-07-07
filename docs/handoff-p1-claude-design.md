# Handoff P1: Claude Design/Copy Follow-Up

Date: 2026-07-08
Owner: Claude for product tone, Korean copy, and visual polish
Codex baseline: P1 server/extension mechanics implemented; see
[handoff-p1-attachment-loop.md](handoff-p1-attachment-loop.md).

## What Codex shipped

- Return celebration plumbing:
  - `PipelineResult{action:"notify", kind:"celebration"}` can be returned without
    an `intervention_id`.
  - The server fires only after confirmed drift -> real OK return, with
    `celebration.min_drift_minutes` and `celebration.cooldown_seconds`.
  - Event: `celebration.delivered`.
- "5분만" break plumbing:
  - Feedback kind: `break`.
  - Config: `break.duration_seconds` default 300.
  - Intervention status becomes `break`; controller silence uses the same
    `snoozed_until` field but is distinguishable in feedback/report data.
- Custom personas:
  - Merge order is `configs/personas.yaml` then `~/.kibitzer/personas.yaml`.
  - `GET /personas` returns `[{key,name}]`.
- Reports/transparency:
  - `GET /sessions/current/report`.
  - `GET /reports/daily?date=YYYY-MM-DD`.
  - `pending_intervention.tier1_reason` and report `judgments[].tier1_reason`.
- Extension mechanics:
  - In-page toast accepts `kind: "intervention" | "celebration"`.
  - Celebration toast currently has no feedback buttons and 9s auto-dismiss.
  - Intervention toast currently has `related` / `break` / `snooze`.
  - Legacy system notification fallback has only `related` / `break` due Chrome's
    2-button limit; body click still means `accepted`.

## Claude-owned work

### 1. Celebration Toast Styling

File: `apps/extension/src/content/toastOverlay.ts`

Keep the no-feedback behavior. Tune:

- celebration visual tone: softer, positive, still Kibitzer-branded;
- auto-dismiss duration if 9s feels wrong;
- whether celebration should play sound; Codex currently does not play sound;
- light/dark polish and buttonless layout spacing.

Do not reintroduce feedback buttons for celebrations.

### 2. Break Button Copy/Layout

Files:

- `apps/extension/src/content/toastOverlay.ts`
- `apps/extension/src/background.ts`
- later: `apps/extension/src/popup/**`

Current provisional copy is `5분만`. Decide final Korean copy and button order for
the in-page toast. The system notification fallback can only show two buttons;
it currently uses `related` + `break`.

### 3. Popup Integration

Files: `apps/extension/src/popup/**`

Replace same-owner persona duplication with `GET /personas`. Then add:

- persona selector sourced from the server;
- session report view backed by `/sessions/current/report`;
- daily report view if it fits the popup surface;
- "왜?" affordance using `pending_intervention.tier1_reason` first, then report
  `judgments[]` for history.

### 4. Copy Tuning

Files:

- `configs/personas.yaml` for persona-owned templates only;
- popup/toast files for UI text.

The existing `celebrate_templates` are already at 6 lines/persona and functional.
Tune only if the live tone feels off. Avoid adding metrics to `quiet_coach`
templates unless the template already asks for `{return_minutes}`.

## Do Not Change

- Do not change server contracts unless coordinating with Codex:
  - `PipelineResult.kind`;
  - `FeedbackKind.break`;
  - `/personas`;
  - `/sessions/current/report`;
  - `/reports/daily`.
- Do not make celebrations create intervention rows.
- Do not make break use `controller.snooze_seconds`; it intentionally uses
  `break.duration_seconds`.

## Claude decisions (2026-07-08, implemented)

1. **Celebration toast**: the character's circle eyes curve into arcs (^ ^) — the
   dry observer's single expression change; no confetti, springier peek curve.
   Kept: 9s auto-dismiss, no sound (praise must not interrupt), #79B7A0 accent,
   no feedback buttons. Fixed a real bug: the buttons row used the `hidden`
   attribute, which `.row { display: flex }` overrides — celebrations were
   showing all three buttons. The row is now omitted from the markup entirely.
2. **Break copy/order**: `5분만` confirmed; toast order related → break → snooze
   (ascending silence duration); fallback 2-button set related + break kept.
3. **Popup**: persona cards now come from `GET /personas` (custom personas get
   the hint "사용자 정의"; server-unreachable falls back to built-ins);
   pending card gains `5분만` (buttons grouped 2×2: verdict feedback / silence
   requests) and a "왜?" toggle showing `tier1_reason`; new 리포트 view backed by
   `/sessions/current/report` — hourly focus strip, longest stretch, feedback
   counts, top drift hosts, recent judgment reasons.
4. **Copy**: `celebrate_templates` left as-is per the handoff.

## Validation To Run After Claude Changes

```bash
.venv/bin/python -m pytest apps/server/tests -q
npm --prefix apps/extension run build
```

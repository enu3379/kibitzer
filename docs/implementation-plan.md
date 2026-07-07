# Implementation Plan

## Stage 0 MVP

### Work Package 1: Project Skeleton

DoD:

- `configs/default.yaml` exists.
- `apps/server` and `apps/extension` have README files.
- Server package imports without side effects.
- Controller interface and streak controller exist.

### Work Package 2: Local Server Basics

DoD:

- `GET /health` returns server status.
- `POST /sessions` creates an active session.
- `POST /sessions/current/goal` stores a declared goal.
- SQLite schema exists for sessions, goals, exemplars, observations, controller state, interventions, feedback, and event log.

### Work Package 3: Browser Observation Intake

DoD:

- Chrome extension relays active-tab navigation events.
- SPA URL changes are observed.
- Tab activation is observed.
- Title capture is debounced by 1-2 seconds.
- Server normalizes input into `Observation`.

### Work Package 4: Privacy Gate

DoD:

- Extension drops sensitive domains before sending.
- Server repeats the same sensitive-domain check.
- Dropped observations are logged without raw URL content.

### Work Package 5: CPU-only Embedding and Tier 0

DoD:

- Embedding provider runs on ONNX Runtime CPU only.
- No CUDA, Metal, or DirectML dependency is required.
- `r0` is computed from goal exemplars and the OK anchor.
- Anchor only updates from OK observations.

### Work Package 6: API Tier 1

DoD:

- Ambiguous observations call a cheap OpenAI-compatible classifier.
- Payload contains goal, recent titles/verdicts, current title, and URL host only.
- Output is strict JSON: `{"verdict":"ok|drift","reason":"..."}`.

### Work Package 7: Controller and Intervention Handshake

DoD:

- Streak controller gates interventions.
- Coldstart, cooldown, and snooze are enforced.
- Server returns `request_excerpt` only when the controller wants to speak.

### Work Package 8: Tier 2 Confirmation and Message

DoD:

- Extension extracts current page excerpt only on request.
- Tier 2 receives minimized payload and can cancel the intervention.
- If Tier 2 is unavailable, server degrades to a local template using the current goal and observation.

### Work Package 9: Notification and Feedback

DoD:

- Notification has at most two sentences.
- Buttons: `related`, `accepted`, `snooze`.
- `related` adds the observation embedding to session exemplars with cap enforcement.
- `snooze` prevents notifications but not logging.
- Feedback submission is duplicate-safe per intervention/kind.

## Stage 0.5

### Work Package 10: Replay CLI

DoD:

- `kibitzer replay --session <id> --config <path>` replays observations.
- Output compares intervention points.
- Alternate controllers can be tested against the same log.

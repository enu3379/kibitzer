# API Layer

HTTP handlers live here. They should be thin:

1. Validate request schemas.
2. Call application/core services.
3. Return explicit extension actions.

Do not put relevance, controller, or provider policy in API handlers.

Current handlers:

- `GET /identity` (versioned local service discovery)
- `GET /health` (mode + tier provider status)
- `POST /sessions`, `GET /sessions/current`, `GET /sessions/current/state`,
  `GET /sessions/current/stats`
- `POST /sessions/current/goal`, `POST /sessions/current/snooze`,
  `POST /sessions/current/end`
- `GET /sessions/current/report`, `GET /reports/daily`
- `GET /personas`
- `GET|PUT /settings`
- `POST /data/delete` (requires `{"confirm":"DELETE"}`)
- `POST /observations/browser-nav`, `POST /observations/{observation_id}/excerpt`
- `POST /feedback`, `POST /interventions/{intervention_id}/delivery`

`POST /observations/browser-nav` accepts an optional opaque `idempotency_key`
(1–128 URL-safe characters). A completed retry with the same key and navigation
payload replays the original response without running the pipeline again. Reusing
the key for a different request, or retrying while the first request is still
processing, returns `409`; the in-flight response includes `Retry-After: 1`.
The key is optional only for the staged extension rollout—event relays should
send one stable key per navigation and retain it across transport retries.

`request_excerpt` responses include an intervention `candidate_id`. The legacy
observation-keyed excerpt route remains the submission endpoint, but it claims
that observation's active candidate before making the Tier 2 call. Candidate
selection does not consume controller evidence; confirmed Tier 2 drift does.
Confirmed and cancelled candidates retain their terminal `PipelineResult`, so
an excerpt retry replays that result instead of invoking Tier 2 again.

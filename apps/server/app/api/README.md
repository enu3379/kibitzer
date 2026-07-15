# API Layer

HTTP handlers live here. They should be thin:

1. Validate request schemas.
2. Call application/core services.
3. Return explicit extension actions.

Do not put relevance, controller, or provider policy in API handlers.

Current handlers:

- `GET /health` (mode + tier provider status)
- `GET /auth/status`, `POST /auth/pair`
- `POST /sessions`, `GET /sessions/current`, `GET /sessions/current/state`,
  `GET /sessions/current/stats`
- `POST /sessions/current/goal`, `POST /sessions/current/snooze`,
  `POST /sessions/current/end`
- `GET /sessions/current/report`, `GET /reports/daily`
- `GET /personas`
- `GET|PUT /settings`
- `POST /data/delete`
- `POST /observations/browser-nav`, `POST /observations/{observation_id}/excerpt`
- `POST /feedback`, `POST /interventions/{intervention_id}/delivery`

Mutating endpoints accept JSON only. `POST /sessions` and
`POST /sessions/current/end` require an explicit `{}` body so they cannot be
invoked as bodyless cross-origin form requests.

All routes other than `/health`, `/auth/status`, and the one-time pairing route
require paired request HMACs and return a response proof.

`request_excerpt` responses include an intervention `candidate_id`. The legacy
observation-keyed excerpt route remains the submission endpoint, but it claims
that observation's active candidate before making the Tier 2 call. Candidate
selection does not consume controller evidence; confirmed Tier 2 drift does.

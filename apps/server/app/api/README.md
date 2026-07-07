# API Layer

HTTP handlers live here. They should be thin:

1. Validate request schemas.
2. Call application/core services.
3. Return explicit extension actions.

Do not put relevance, controller, or provider policy in API handlers.

Current handlers:

- `GET /health` (mode + tier provider status)
- `POST /sessions`, `GET /sessions/current`, `GET /sessions/current/state`,
  `GET /sessions/current/stats`
- `POST /sessions/current/goal`, `POST /sessions/current/snooze`,
  `POST /sessions/current/end`
- `GET /sessions/current/report`, `GET /reports/daily`
- `GET /personas`
- `GET|PUT /settings`
- `POST /observations/browser-nav`, `POST /observations/{observation_id}/excerpt`
- `POST /feedback`, `POST /interventions/{intervention_id}/delivery`

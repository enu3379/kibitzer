# API Layer

HTTP handlers live here. They should be thin:

1. Validate request schemas.
2. Call application/core services.
3. Return explicit extension actions.

Do not put relevance, controller, or provider policy in API handlers.

Current Stage 0 handlers:

- `POST /sessions`
- `GET /sessions/current`
- `POST /sessions/current/goal`
- `POST /observations/browser-nav`
- `POST /observations/{observation_id}/excerpt`
- `POST /feedback`

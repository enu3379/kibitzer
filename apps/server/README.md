# Kibitzer Server

The server is the local SSOT for Kibitzer.

## Responsibilities

- session and goal management
- observation normalization
- privacy gating
- CPU-only embedding provider orchestration
- Tier 0 relevance
- Tier 1 API classification
- controller state
- Tier 2 confirmation and message generation
- event logging and replay

## Non-responsibilities

- Chrome API handling
- notification UI
- continuous page body collection
- keystroke capture

## API

```text
GET  /health                          (includes tier provider status)
GET  /auth/status                     (public pairing state only)
POST /auth/pair                       (exact extension origin required)
POST /sessions
GET  /sessions/current
GET  /sessions/current/state
GET  /sessions/current/stats
POST /sessions/current/goal
POST /sessions/current/snooze
POST /sessions/current/end
GET  /sessions/current/report
GET  /reports/daily?date=YYYY-MM-DD
GET  /personas
GET|PUT /settings
POST /data/delete                     (requires {"confirm":"DELETE"})
POST /observations/browser-nav
POST /observations/{id}/excerpt
POST /feedback
POST /interventions/{id}/delivery
```

All `POST`, `PUT`, and `PATCH` requests must use `Content-Type:
application/json`. Session creation and ending use an explicit empty JSON body
(`{}`); browser cross-origin mutations are rejected by the local API security
middleware.

Except for `/health`, `/auth/status`, and the one-time `/auth/pair`, API calls
must also carry a valid paired HMAC. The server binds signed responses to the
request nonce and body so the extension can reject a process impersonating the
server on port 8765. Pairing state lives in owner-only files under `data/`.

When the controller returns `request_excerpt`, the response also contains a
`candidate_id`. Candidate creation preserves streak/alignment state. Tier 2
confirmation creates the intervention and consumes that state; cancellation or
candidate expiry does not.

Still planned: `POST /replay` (Work Package 10, gated on the D4 scope decision).

## Implementation Note

Embedding is CPU-only in Stage 0. Tier 1 and Tier 2 are API providers behind interfaces.

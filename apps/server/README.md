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
POST /observations/browser-nav
POST /observations/{id}/excerpt
POST /feedback
POST /interventions/{id}/delivery
```

When the controller returns `request_excerpt`, the response also contains a
`candidate_id`. Candidate creation preserves streak/alignment state. Tier 2
confirmation creates the intervention and consumes that state; cancellation or
candidate expiry does not.

Still planned: `POST /replay` (Work Package 10, gated on the D4 scope decision).

## Implementation Note

Embedding is CPU-only in Stage 0. Tier 1 and Tier 2 are API providers behind interfaces.

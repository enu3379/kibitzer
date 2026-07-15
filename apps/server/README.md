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
GET  /identity                        (versioned local service discovery)
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
GET  /observations/page-state?tab_id=&url_host=&url_path_hash=
POST /observations/{id}/excerpt
POST /feedback
POST /interventions/{id}/delivery
```

`GET /identity` prevents local port discovery from accepting an unrelated
service. It is a discovery marker, not an authentication boundary.

The popup submits goals with `POST /sessions/current/goal?ensure_session=true`.
That mode creates an active session in the same storage transaction when none
exists; the default endpoint still returns 404 without an active session.

When the controller returns `request_excerpt`, the response also contains a
`candidate_id`. Candidate creation preserves streak/alignment state. Tier 2
confirmation creates the intervention and consumes that state; cancellation or
candidate expiry does not.

Still planned: `POST /replay` (Work Package 10, gated on the D4 scope decision).

## Implementation Note

Embedding is CPU-only in Stage 0. Tier 1 and Tier 2 are API providers behind interfaces.

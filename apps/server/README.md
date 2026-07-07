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

## Planned API

```text
GET  /health
POST /sessions
GET  /sessions/current
POST /sessions/current/goal
POST /observations/browser-nav
POST /observations/{id}/excerpt
POST /feedback
POST /replay
```

## Implementation Note

Embedding is CPU-only in Stage 0. Tier 1 and Tier 2 are API providers behind interfaces.


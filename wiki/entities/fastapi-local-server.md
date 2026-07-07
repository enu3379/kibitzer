---
type: entity
title: FastAPI Local Server
tags: [server, fastapi, sqlite]
related: [observation-pipeline, streak-controller, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# FastAPI Local Server

The local server is the single source of truth for Kibitzer sessions.

It owns:

- active session
- declared goal
- exemplars
- OK anchor
- controller state
- observation verdicts
- event log
- feedback

The server exposes APIs for the extension but keeps intervention policy inside the core pipeline.


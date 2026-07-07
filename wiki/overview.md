---
type: overview
title: Kibitzer Overview
tags: [kibitzer, architecture]
related: [kibitzer, observation-pipeline, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Kibitzer Overview

Kibitzer observes browser navigation against a declared goal and intervenes only after drift accumulates. The project prioritizes low annoyance over high recall.

Stage 0 focuses on Chrome navigation. The server owns all session state and the extension remains a stateless relay plus notification surface.

The ML boundary is deliberately portable: embeddings are local CPU-only, while Tier 1 and Tier 2 can use OpenAI-compatible commercial APIs with minimized payloads.

## Current Implementation Shape

- `apps/server/` contains the Python FastAPI local server.
- `apps/extension/` contains the Chrome MV3 extension.
- `configs/` contains thresholds, provider selection, and privacy lists.
- `docs/` contains design and implementation contracts.
- `wiki/` contains LLM Wiki summaries for navigation and future sessions.
- `raw/sources/project-docs/` exposes canonical project docs to LLM Wiki.


---
type: entity
title: Server Core Pipeline Module
tags: [code-map, server, pipeline]
related: [fastapi-local-server, observation-pipeline, streak-controller, tiered-drift-judging]
created: 2026-07-03
updated: 2026-07-03
---

# Server Core Pipeline Module

This module group owns source-neutral observation judgment and controller handoff.

## Responsibilities

- calculate Tier 0 relevance
- maintain OK-only anchor state
- update controllers from verdict streams
- return extension actions such as `none` or `request_excerpt`

## Files

- `apps/server/app/core/pipeline.py`
- `apps/server/app/core/relevance.py`
- `apps/server/app/core/anchor.py`
- `apps/server/app/core/controllers/base.py`
- `apps/server/app/core/controllers/streak.py`
- `apps/server/app/schemas.py`

## Linked Concepts

- [[observation-pipeline]]
- [[streak-controller]]
- [[tiered-drift-judging]]


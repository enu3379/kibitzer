---
type: entity
title: Server Provider Boundaries Module
tags: [code-map, server, providers, ml]
related: [local-cpu-embedding, tiered-drift-judging, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Server Provider Boundaries Module

This module group isolates model/provider details from core pipeline logic.

## Responsibilities

- define CPU-only embedding provider contract
- define Tier 1/Tier 2 judge provider contract
- keep model names and endpoint details out of core logic
- make provider replacement a config/runtime concern

## Files

- `apps/server/app/providers/README.md`
- `apps/server/app/providers/embeddings/base.py`
- `apps/server/app/providers/judges/base.py`
- `apps/server/app/providers/embeddings/README.md`
- `apps/server/app/providers/judges/README.md`
- `docs/ml-providers.md`
- `configs/default.yaml`

## Linked Concepts

- [[local-cpu-embedding]]
- [[tiered-drift-judging]]
- [[privacy-boundary]]


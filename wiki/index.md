---
type: overview
title: Kibitzer Wiki Index
tags: []
related: []
created: 2026-07-03
updated: 2026-07-05
---

# Kibitzer Wiki Index

## Entities

- [[kibitzer]] - Local non-blocking attention guard for declared-goal browser sessions
- [[chrome-extension-adapter]] - MV3 event relay and notification delivery layer
- [[fastapi-local-server]] - Local SSOT server for sessions, observations, verdicts, and replay logs
- [[server-core-pipeline-module]] - Server-side source-neutral relevance/controller pipeline code map
- [[server-provider-boundaries-module]] - Provider interface and ML/API boundary code map
- [[extension-background-worker-module]] - Chrome MV3 background worker code map

## Concepts

- [[observation-pipeline]] - Source-neutral flow from raw events to verdicts and interventions
- [[local-cpu-embedding]] - Stage 0 embedding policy requiring portable CPU-only inference
- [[tiered-drift-judging]] - Tier 0/1/2 cascade separating cheap relevance from rare precise confirmation
- [[streak-controller]] - Stage 0 intervention controller based on consecutive DRIFT verdicts
- [[notification-feedback-loop]] - Chrome notification actions and server-side feedback effects
- [[privacy-boundary]] - Data minimization rules for browser observations and external API payloads
- [[llm-wiki-project-root-integration]] - Direct project-root integration pattern for this repository
- [[code-map-pages]] - Convention for representing code files through module-level wiki pages

## Sources

- [[kibitzer-root-readme]] - Root README source exposed through `raw/sources/project-docs`
- [[kibitzer-architecture-doc]] - Architecture document source exposed through `raw/sources/project-docs`
- [[kibitzer-ml-providers-doc]] - ML provider policy document source exposed through `raw/sources/project-docs`

## Queries

- [[should-source-docs-be-symlinked-or-copied]] - Tracks whether LLM Wiki handles symlinked source docs well enough

## Synthesis

- [[stage-0-implementation-boundaries]] - Current boundaries for what Stage 0 will and will not implement

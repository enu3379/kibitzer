---
type: entity
title: Kibitzer
tags: [project, local-ai]
related: [observation-pipeline, tiered-drift-judging, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Kibitzer

Kibitzer is a local non-blocking attention guard. The user declares a goal, the browser adapter emits observations, and the controller only allows a comment after drift has accumulated.

The Stage 0 implementation watches Chrome navigation only. It does not monitor keystrokes or agent prompts.

## Design Bias

The project is intentionally conservative:

- false positives are more damaging than misses
- interventions never block user action
- raw page body is not collected continuously
- local session state is the SSOT


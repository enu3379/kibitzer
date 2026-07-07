---
type: synthesis
title: Stage 0 Implementation Boundaries
tags: [stage-0, implementation]
related: [kibitzer, observation-pipeline, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Stage 0 Implementation Boundaries

Stage 0 builds only the browser-navigation product loop:

- declared goal
- active-tab navigation observations
- CPU-only local embeddings
- API Tier 1 classifier
- streak controller
- Tier 2 confirmation/message
- Chrome notification feedback
- replayable event log

It explicitly excludes keystrokes, agent prompts, inferred goals, multiple concurrent goals, dashboards, blocking interventions, and permanent cross-session learning.


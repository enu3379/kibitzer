---
type: concept
title: Observation Pipeline
tags: [architecture, pipeline]
related: [kibitzer, chrome-extension-adapter, fastapi-local-server]
created: 2026-07-03
updated: 2026-07-03
---

# Observation Pipeline

The pipeline converts source-specific browser events into source-neutral observations.

```text
Raw browser event
  -> Observation
  -> embedding
  -> Tier 0 relevance
  -> optional Tier 1 classification
  -> controller update
  -> optional Tier 2 confirmation
  -> notification
```

The pipeline must not know Chrome-specific APIs. New sources should enter by adding adapters, not by modifying relevance or controller logic.


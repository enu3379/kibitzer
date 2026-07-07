---
type: concept
title: Privacy Boundary
tags: [privacy, data-minimization]
related: [local-cpu-embedding, chrome-extension-adapter]
created: 2026-07-03
updated: 2026-07-03
---

# Privacy Boundary

Sensitive domains are dropped before observation creation. The extension performs a first-pass drop and the server repeats the check.

Tier 1 receives only minimized title and host metadata. Tier 2 receives a bounded page excerpt only after drift has accumulated and just before an intervention.

Page excerpts are transient and must not be persisted.


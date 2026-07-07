---
type: concept
title: Tiered Drift Judging
tags: [ml, judging, drift]
related: [local-cpu-embedding, streak-controller]
created: 2026-07-03
updated: 2026-07-04
---

# Tiered Drift Judging

Kibitzer separates relevance judgment from intervention control.

Tier 0 uses local CPU embeddings and cosine similarity. Tier 1 uses a cheap API classifier for ambiguous title/host cases. Tier 2 runs only immediately before speaking and receives a bounded page excerpt.

This keeps cost and raw-data exposure low while preserving a final high-precision check before the user sees a notification.

Work Package 8 wires Tier 2 through `/observations/{observation_id}/excerpt`. The Chrome extension sends an excerpt only after the server returns `request_excerpt`. The server then builds a minimized payload with the goal, recent title/verdict pairs, current title/host/verdict/score, and a char-limited excerpt.

The default Tier 2 provider uses the experiment model file to configure Ollama Cloud `gemma4:31b` via `https://ollama.com/api/chat`. API keys remain in the experiment project or environment variables and are not copied into Kibitzer.

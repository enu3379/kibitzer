---
type: concept
title: Local CPU Embedding
tags: [embedding, portability, ml]
related: [tiered-drift-judging, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Local CPU Embedding

Stage 0 requires embedding to run locally on CPU. CUDA, Metal, and DirectML are not required.

The default provider is planned as ONNX Runtime CPU with a small multilingual model. This keeps Mac and Windows setups consistent.

Tier 1 and Tier 2 may use external APIs, but embedding is local because it sees the full observation stream.


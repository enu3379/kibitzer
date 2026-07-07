---
type: concept
title: LLM Wiki Project-root Integration
tags: [llm-wiki, documentation]
related: [kibitzer]
created: 2026-07-03
updated: 2026-07-03
---

# LLM Wiki Project-root Integration

Kibitzer uses direct project-root integration with LLM Wiki.

The repository root contains `purpose.md`, `schema.md`, `wiki/`, and `raw/sources/`, so LLM Wiki can open the project directly instead of relying on a separate Obsidian vault copy.

Stable source docs are exposed through symlinks under `raw/sources/project-docs/`.


---
type: concept
title: Code Map Pages
tags: [llm-wiki, code-navigation]
related: [llm-wiki-project-root-integration]
created: 2026-07-03
updated: 2026-07-03
---

# Code Map Pages

Kibitzer represents source code in LLM Wiki through module-level code map pages rather than one graph node per file.

Each code map page contains:

- the module responsibility
- the relevant code file paths
- links to architecture concepts

This keeps the graph useful while still letting Codex and humans jump from design concepts to concrete files.


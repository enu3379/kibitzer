---
type: query
title: Should Source Docs Be Symlinked or Copied?
tags: [llm-wiki, open-question]
related: [llm-wiki-project-root-integration]
created: 2026-07-03
updated: 2026-07-03
---

# Should Source Docs Be Symlinked or Copied?

Current plan: use symlinks under `raw/sources/project-docs/` that point to canonical docs in the repo.

Question: does LLM Wiki's source watch and ingest pipeline handle these symlinks reliably on both Mac and Windows?

If symlinks are unreliable on Windows, fall back to generated source snapshots rather than manual copies.


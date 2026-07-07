# Wiki Schema

This project root is both a code repository and an LLM Wiki project.

## Public Roots

LLM Wiki should use:

- `purpose.md` for intent and scope.
- `schema.md` for maintenance rules.
- `wiki/` for curated project knowledge.
- `raw/sources/` for source documents, usually symlinks to canonical repo docs.

Do not ingest or summarize:

- `.env`
- `data/`
- `.venv/`
- `node_modules/`
- SQLite databases
- browser observation logs
- page excerpts
- credentials or API keys

## Page Types

| Type | Directory | Purpose |
|---|---|---|
| entity | `wiki/entities/` | Named systems, apps, modules, libraries, APIs |
| concept | `wiki/concepts/` | Design ideas, algorithms, contracts, privacy rules |
| source | `wiki/sources/` | Source documents from `raw/sources/` |
| code | `wiki/code/` | Generated searchable snapshots of allowlisted code files |
| query | `wiki/queries/` | Open implementation questions |
| synthesis | `wiki/synthesis/` | Cross-cutting implementation decisions |
| overview | `wiki/` | Index, log, and overview pages |

## Naming

- Use kebab-case filenames.
- Use English slugs even when body text is Korean.
- Keep one concept per page.
- Prefer stable architecture names over transient task names.

## Frontmatter

All wiki pages must include:

```yaml
---
type: entity | concept | source | code | query | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

Source pages also include:

```yaml
source_path: raw/sources/...
canonical_path: ...
```

## Index Rules

`wiki/index.md` lists all pages grouped by type:

```text
- [[page-slug]] - one-line description
```

## Log Rules

`wiki/log.md` is append-only and reverse chronological when practical:

```text
## [YYYY-MM-DD] category | short title

- Change or decision.
```

## Code-project Rules

- Link implementation folders to design concepts.
- Record important design decisions as synthesis pages.
- Keep README files as developer-facing source of truth.
- Keep wiki pages concise and navigational.
- Do not paste runtime logs into wiki pages.

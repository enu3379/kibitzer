# LLM Wiki Integration

## Detected Local Setup

An existing vault was detected at:

```text
<local-obsidian-vault>
```

It contains:

```text
purpose.md
schema.md
wiki/index.md
wiki/log.md
.llm-wiki/project.json
raw/sources/
```

The local LLM Wiki API is running at:

```text
http://127.0.0.1:19828
```

The API currently requires authentication. For project work, the preferred integration is not to mirror this project into that vault. Instead, `<kibitzer-project-root>` itself is structured as an LLM Wiki project root.

The app registry currently includes both `MyVault` and `Kibitzer`. The active project should be `Kibitzer` when using the Codex-facing search helper.

Current setup note: Kibitzer has been added to the local app registry. LLM Wiki API/MCP are enabled for project lookup/search. Source Watch and auto-ingest are intentionally disabled so opening the app does not automatically spend LLM tokens.

## Direct Project-root Contract

The Kibitzer repo contains:

```text
purpose.md
schema.md
wiki/
raw/sources/
.llm-wiki/
```

Stable project docs are exposed to LLM Wiki as copied snapshots under:

```text
raw/sources/project-docs/
```

The canonical files remain in the repo root and `docs/`; do not edit the
snapshots directly.

Run this after adding durable docs or folder README files:

```bash
bash scripts/sync-llm-wiki-sources.sh
```

The script exposes documentation and README files, not every source code file. It prunes dependency/build output such as `node_modules`, `dist`, and `build`.

Run this after ordinary implementation work to refresh both docs and generated code-search pages:

```bash
bash scripts/refresh-llm-wiki-context.sh
```

## Registration

Expected manual registration flow:

1. Open LLM Wiki.
2. Choose open/create project.
3. Select `<kibitzer-project-root>`.
4. Confirm that the app sees `purpose.md`, `schema.md`, `wiki/`, and `raw/sources/project-docs/`.

After this, LLM Wiki should add the project to its registry and the local API should be able to resolve it by project id.

## What Updates Automatically?

Current operating mode: nothing is auto-ingested. Source Watch is disabled to avoid surprise LLM spend during active development.

The intended loop is:

1. Change code/docs.
2. Run `bash scripts/refresh-llm-wiki-context.sh`.
3. Use `node scripts/llm-wiki-search.mjs "<query>" <topK>` for project lookup.
4. Manually ingest selected durable docs only when the wiki summary/graph should be updated.

If Source Watch is explicitly enabled later, refresh document snapshots before
ingest so LLM Wiki sees the current canonical docs. Keep auto-ingest off unless
the token/cost tradeoff is intentional.

If a new document is added outside `raw/sources/`, it must be exposed first. Use `scripts/sync-llm-wiki-sources.sh` for durable docs and README files.

If new code files are added, they are not automatically ingested as wiki knowledge. The intended workflow is:

1. Add or update folder README files for stable module contracts.
2. Run the sync script.
3. Let LLM Wiki ingest the exposed README/docs source files.
4. Update curated `wiki/` pages only for important architecture or design changes.

LLM Wiki graph links come from generated/curated wiki pages and their `[[wikilinks]]`; raw code files do not automatically become useful graph nodes.

For code-content search, run:

```bash
bash scripts/sync-llm-wiki-code-sources.sh
```

This creates generated markdown snapshots in `wiki/code/` for allowlisted code files, plus matching trace copies in `raw/sources/code-files/`. Codex can then use LLM Wiki search to find code symbols while curated module pages explain the architecture.

Codex-facing search helper:

```bash
node scripts/llm-wiki-search.mjs "StreakController should_intervene" 5
```

This calls the local LLM Wiki API with the registered Kibitzer project id. Each run writes a compact, token-safe JSON log under:

```text
.llm-wiki/runs/search/
```

The log records query, timestamp, result paths/titles/scores/snippets, and status. It does not store the LLM Wiki API token.

## What to Expose

Expose stable design documents:

- root README
- docs architecture pages
- config reference
- major folder README files
- implementation decisions

Do not expose:

- `.env`
- `data/`
- SQLite DBs
- browser logs
- page excerpts
- API keys

## Evaluation Questions

Use this project to assess whether LLM Wiki is useful for:

- keeping architecture decisions discoverable
- linking implementation folders to concepts
- tracing why provider choices were made
- recording privacy constraints as durable design knowledge
- supporting future Codex sessions with project context

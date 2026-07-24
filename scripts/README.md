# Scripts

Project maintenance scripts live here.

## `gen-personas.py`

Regenerates `apps/extension-next/src/lib/personas.data.ts` from the persona
sources under `configs/`. It vendors `configs/personas/*.yaml` into the TS
module verbatim (no hand-copying) using `configs/personas.yaml` for the persona
order and default.

Run it after editing any `configs/personas*.yaml`:

```bash
python scripts/gen-personas.py
```

## `sync-llm-wiki-sources.sh`

Refreshes copied snapshots under `raw/sources/project-docs/` for stable project documents.

This lets LLM Wiki ingest documentation while canonical files stay in the repo
root, `docs/`, and module README locations.

The script intentionally does not expose every source code file. Code is summarized through folder README files and curated wiki pages to avoid noisy graph output.
Dependency/build folders such as `node_modules`, `dist`, and `build` are pruned.

## `sync-llm-wiki-code-sources.sh`

Creates generated markdown snapshots under both:

- `raw/sources/code-files/` for source trace/debug.
- `wiki/code/` for llm-wiki API keyword search.

Use this when Codex should be able to use LLM Wiki search to find code symbols or implementation details. The graph should still use module-level wiki pages rather than one graph node per raw file.

## `refresh-llm-wiki-context.sh`

Runs both LLM Wiki sync scripts and prints the refreshed source counts.

```bash
bash scripts/refresh-llm-wiki-context.sh
```

Use this after ordinary implementation work before asking Codex to search the Kibitzer project through LLM Wiki.

## `llm-wiki-search.mjs`

Small Codex-facing helper around the local LLM Wiki API.

```bash
node scripts/llm-wiki-search.mjs "StreakController should_intervene" 5
```

It reads the local API token from LLM Wiki app-state and searches the registered Kibitzer project.

Each invocation writes a compact JSON run log under `.llm-wiki/runs/search/`.
The log includes query, timestamp, result paths/titles/scores/snippets, and status. It never writes the API token.

## `fixtures/`

Historical benchmark and smoke datasets: the Tier 0 embedding benchmark datasets
(v1/v2), guidelines, goal-enrichment simulation phrases, and the ONNX and Tier 2
smoke cases. Their Python runners were removed in the migration to the serverless
extension; the evidence snapshots produced from these datasets live under
`docs/benchmarks/`. The datasets are kept for reproducibility.

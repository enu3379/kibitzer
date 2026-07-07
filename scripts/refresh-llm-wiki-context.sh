#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT/scripts/sync-llm-wiki-sources.sh"
bash "$ROOT/scripts/sync-llm-wiki-code-sources.sh"

project_docs_count="$(find "$ROOT/raw/sources/project-docs" -maxdepth 1 \( -type f -o -type l \) | wc -l | tr -d ' ')"
code_source_count="$(find "$ROOT/raw/sources/code-files" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
wiki_code_count="$(find "$ROOT/wiki/code" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"

printf 'LLM Wiki context refreshed for Kibitzer\n'
printf 'project docs: %s\n' "$project_docs_count"
printf 'raw code sources: %s\n' "$code_source_count"
printf 'wiki code pages: %s\n' "$wiki_code_count"
printf '\nSearch example:\n'
printf '  node scripts/llm-wiki-search.mjs "StreakController should_intervene" 5\n'

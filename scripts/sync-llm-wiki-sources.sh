#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/raw/sources/project-docs"

mkdir -p "$DEST"
find "$DEST" -maxdepth 1 \( -type f -o -type l \) -delete

link_doc() {
  local source_rel="$1"
  local target_name="$2"
  local source_abs="$ROOT/$source_rel"
  local target_abs="$DEST/$target_name"

  if [[ ! -f "$source_abs" ]]; then
    echo "skip missing: $source_rel" >&2
    return
  fi

  ln -sfn "../../../$source_rel" "$target_abs"
}

link_doc "README.md" "README.md"
link_doc "docs/README.md" "docs-readme.md"
link_doc "docs/architecture.md" "architecture.md"
link_doc "docs/data-model.md" "data-model.md"
link_doc "docs/implementation-plan.md" "implementation-plan.md"
link_doc "docs/llm-wiki-integration.md" "llm-wiki-integration.md"
link_doc "docs/ml-providers.md" "ml-providers.md"
link_doc "docs/privacy.md" "privacy.md"
link_doc "docs/replay-harness.md" "replay-harness.md"
link_doc "configs/README.md" "configs-readme.md"
link_doc "configs/default.yaml" "default-config.yaml"
link_doc "scripts/README.md" "scripts-readme.md"
link_doc "apps/README.md" "apps-readme.md"
link_doc "apps/server/README.md" "server-readme.md"
link_doc "apps/extension/README.md" "extension-readme.md"

find "$ROOT/apps" \
  \( -path "*/node_modules/*" -o -path "*/dist/*" -o -path "*/build/*" \) -prune \
  -o -path "*/README.md" -type f -print | while IFS= read -r readme; do
  rel="${readme#"$ROOT/"}"
  case "$rel" in
    apps/README.md|apps/server/README.md|apps/extension/README.md)
      continue
      ;;
  esac
  safe_name="$(echo "$rel" | tr '/' '-' | sed 's/\.md$/.md/')"
  link_doc "$rel" "$safe_name"
done

echo "synced LLM Wiki source links in $DEST"

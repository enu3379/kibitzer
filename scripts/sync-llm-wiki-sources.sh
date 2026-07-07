#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/raw/sources/project-docs"

mkdir -p "$DEST"
find "$DEST" -maxdepth 1 \( -type f -o -type l \) -delete

sync_doc() {
  local source_rel="$1"
  local target_name="$2"
  local source_abs="$ROOT/$source_rel"
  local target_abs="$DEST/$target_name"

  if [[ ! -f "$source_abs" ]]; then
    echo "skip missing: $source_rel" >&2
    return
  fi

  cp "$source_abs" "$target_abs"
}

sync_doc "README.md" "README.md"
sync_doc "docs/README.md" "docs-readme.md"
sync_doc "docs/architecture.md" "architecture.md"
sync_doc "docs/data-model.md" "data-model.md"
sync_doc "docs/idle-daemon-plan.md" "idle-daemon-plan.md"
sync_doc "docs/implementation-plan.md" "implementation-plan.md"
sync_doc "docs/llm-wiki-integration.md" "llm-wiki-integration.md"
sync_doc "docs/macos-menu-bar-plan.md" "macos-menu-bar-plan.md"
sync_doc "docs/ml-providers.md" "ml-providers.md"
sync_doc "docs/platforms.md" "platforms.md"
sync_doc "docs/progress.md" "progress.md"
sync_doc "docs/privacy.md" "privacy.md"
sync_doc "docs/replay-harness.md" "replay-harness.md"
sync_doc "docs/windows-idle-tray-plan.md" "windows-idle-tray-plan.md"
sync_doc "configs/README.md" "configs-readme.md"
sync_doc "configs/default.yaml" "default-config.yaml"
sync_doc "scripts/README.md" "scripts-readme.md"
sync_doc "apps/README.md" "apps-readme.md"
sync_doc "apps/server/README.md" "server-readme.md"
sync_doc "apps/extension/README.md" "extension-readme.md"

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
  sync_doc "$rel" "$safe_name"
done

echo "synced LLM Wiki document snapshots in $DEST"

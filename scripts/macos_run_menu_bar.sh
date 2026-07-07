#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="$ROOT/apps/menubar/macos/build/KibitzerMenuBar"
SOURCE="$ROOT/apps/menubar/macos/KibitzerMenuBar.swift"

if [[ ! -x "$BINARY" || "$SOURCE" -nt "$BINARY" ]]; then
  bash "$ROOT/scripts/macos_build_menu_bar.sh"
fi

exec "$BINARY" "$ROOT"

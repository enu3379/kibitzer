#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/apps/menubar/macos/KibitzerMenuBar.swift"
BUILD_DIR="$ROOT/apps/menubar/macos/build"
OUTPUT="$BUILD_DIR/KibitzerMenuBar"
MODULE_CACHE="$BUILD_DIR/module-cache"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc is required. Install Xcode Command Line Tools, then rerun this script." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR" "$MODULE_CACHE"
if ! CLANG_MODULE_CACHE_PATH="$MODULE_CACHE" swiftc \
  "$SOURCE" \
  -o "$OUTPUT" \
  -framework AppKit \
  -module-cache-path "$MODULE_CACHE"; then
  echo "Swift build failed." >&2
  echo "If the error mentions an unsupported SDK/compiler mismatch, update or reinstall Xcode Command Line Tools." >&2
  exit 1
fi

echo "Built $OUTPUT"

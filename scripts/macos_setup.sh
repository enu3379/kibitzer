#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p data

if [[ ! -x ".venv/bin/python" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv .venv
  elif command -v python3.11 >/dev/null 2>&1; then
    python3.11 -m venv .venv
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m venv .venv
  else
    echo "Python 3.11+ is required. Install Python, then rerun this script." >&2
    exit 1
  fi
fi

".venv/bin/python" -m pip install --upgrade pip
".venv/bin/python" -m pip install -e ".[test]"

npm --prefix apps/extension install
npm --prefix apps/extension run build

echo "Setup complete. Start the server with bash scripts/macos_run_server.sh"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -x ".venv/bin/python" ]]; then
  echo "Missing .venv. Run bash scripts/macos_setup.sh first." >&2
  exit 1
fi

mkdir -p data

exec ".venv/bin/python" -m uvicorn apps.server.app.main:app --host 127.0.0.1 --port "${KIBITZER_PORT:-8765}"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.kibitzer.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT/data/logs"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Missing .venv. Run bash scripts/macos_setup.sh first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$ROOT/data"

"$ROOT/.venv/bin/python" - "$PLIST" "$LABEL" "$ROOT" "$LOG_DIR" <<'PYTHON'
import plistlib
import sys
from pathlib import Path

_, plist_path, label, root, log_dir = sys.argv
payload = {
    "Label": label,
    "ProgramArguments": [
        "/bin/bash",
        str(Path(root) / "scripts" / "macos_run_server.sh"),
    ],
    "WorkingDirectory": root,
    "RunAtLoad": True,
    "KeepAlive": {"Crashed": True},
    "ProcessType": "Background",
    "EnvironmentVariables": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "PYTHONUNBUFFERED": "1",
    },
    "StandardOutPath": str(Path(log_dir) / "macos-launch-agent.out.log"),
    "StandardErrorPath": str(Path(log_dir) / "macos-launch-agent.err.log"),
}

with Path(plist_path).open("wb") as output:
    plistlib.dump(payload, output, fmt=plistlib.FMT_XML, sort_keys=False)
PYTHON

bootout_status=0
bootout_output="$(launchctl bootout "gui/${UID}/${LABEL}" 2>&1)" || bootout_status=$?
if [[ "$bootout_status" -ne 0 && "$bootout_status" -ne 3 ]]; then
  if [[ -n "$bootout_output" ]]; then
    printf '%s\n' "$bootout_output" >&2
  else
    printf 'Failed to boot out %s (exit %s).\n' "$LABEL" "$bootout_status" >&2
  fi
  exit "$bootout_status"
fi
launchctl bootstrap "gui/${UID}" "$PLIST"
launchctl enable "gui/${UID}/${LABEL}"
launchctl kickstart -k "gui/${UID}/${LABEL}"

echo "Installed and started ${LABEL}."
echo "Effective port: ${ROOT}/data/kibitzer.port"
echo "Logs: ${LOG_DIR}/macos-launch-agent.out.log and .err.log"

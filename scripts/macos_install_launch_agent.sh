#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.kibitzer.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT/data/logs"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "Missing .venv. Run bash scripts/macos_setup.sh first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$ROOT/data"
chmod 700 "$LOG_DIR" "$ROOT/data"
[[ ! -f "$ROOT/.env" ]] || chmod 600 "$ROOT/.env"
[[ ! -f "$ROOT/configs/models.local.yaml" ]] || chmod 600 "$ROOT/configs/models.local.yaml"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/macos_run_server.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/macos-launch-agent.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/macos-launch-agent.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "$PLIST"
launchctl enable "gui/${UID}/${LABEL}"
launchctl kickstart -k "gui/${UID}/${LABEL}"

echo "Installed and started ${LABEL}."
echo "Health: curl http://127.0.0.1:8765/health"
echo "Logs: ${LOG_DIR}/macos-launch-agent.out.log and .err.log"

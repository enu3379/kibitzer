#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.kibitzer.menubar"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT/data/logs"

bash "$ROOT/scripts/macos_build_menu_bar.sh"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$ROOT/data"

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
    <string>${ROOT}/scripts/macos_run_menu_bar.sh</string>
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
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <array>
    <string>Aqua</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/macos-menu-bar.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/macos-menu-bar.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/${UID}" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "$PLIST"
launchctl enable "gui/${UID}/${LABEL}"
launchctl kickstart -k "gui/${UID}/${LABEL}"

echo "Installed and started ${LABEL}."
echo "Logs: ${LOG_DIR}/macos-menu-bar.out.log and .err.log"

#!/usr/bin/env bash
set -euo pipefail

LABEL="com.kibitzer.server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

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
rm -f "$PLIST"

echo "Uninstalled ${LABEL}."

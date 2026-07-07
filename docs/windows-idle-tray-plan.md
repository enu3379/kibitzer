# Windows Idle Tray Plan

This is the Windows-specific follow-up to [Idle Daemon Plan](idle-daemon-plan.md).
The server core should stay shared: one FastAPI process owns the HTTP port,
SQLite state, and runtime mode. Windows work belongs at the startup and tray
surface.

## Goal

Make Kibitzer feel available after login without forcing the user to keep a
terminal window open.

Target states:

```text
dead    no response from http://127.0.0.1:8765/health
idle    server responds with mode=idle
active  server responds with mode=active
```

The Chrome extension badge remains the extension-to-server reachability signal.
The Windows tray icon should show the local process/server state.

## Proposed Phases

### Phase 1: Startup Registration

- Add `scripts/windows_install_startup.ps1`.
- Add `scripts/windows_uninstall_startup.ps1`.
- Prefer a per-user scheduled task at logon over copying shortcuts into Startup:
  scheduled tasks give clearer status, logs, and working-directory control.
- The task should run `scripts/windows_run_server.ps1` from the repository root.
- Logs should go under `data\logs\`.

Acceptance checks:

- `Get-ScheduledTask` shows the Kibitzer task.
- Logging out/in starts the server without a visible terminal.
- `Invoke-RestMethod http://127.0.0.1:8765/health` returns `mode = idle`.

### Phase 2: Tray Status

- Add a small tray process that polls `GET /health`.
- Map state to icon:
  - `dead`: warning/red
  - `idle`: gray
  - `active`: color
- Tray menu:
  - Open Chrome extension page or Kibitzer popup instructions.
  - Open logs folder.
  - Restart server.
  - Stop server.
  - Quit tray.

Recommended implementation:

- Use Python + `pystray` only if packaging remains Python-first.
- If a Windows installer/app shell is introduced, keep the tray adapter native to
  that package instead of adding a second long-lived worker.

The tray must not own judging state. It observes and controls the same server
process; it does not run a separate heavy worker.

### Phase 3: Packaging

- Add packaging under `packaging/windows/`.
- Decide whether the packaged app bundles Python or expects the repo `.venv`.
- Keep API keys and `configs\models.local.yaml` local-only.
- Preserve manual scripts for development and debugging.

## Non-goals

- Do not move Tier 1/Tier 2 logic into the Chrome extension.
- Do not create separate lightweight and heavyweight server programs.
- Do not store provider credentials in the tray app or extension.
- Do not make Windows-only changes inside the shared observation pipeline unless
  a native dependency forces an adapter.

## Open Questions

- Whether tray icons should be generated from existing extension icons or have
  separate Windows-native assets.
- Whether restart/stop should control a scheduled task, a child process, or a
  packaged app service wrapper.
- Whether Windows voice should use SAPI later or keep voice disabled until a
  dedicated voice pass.

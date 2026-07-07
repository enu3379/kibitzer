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
unknown server responds without a known mode
```

The Chrome extension badge remains the extension-to-server reachability signal.
The Windows tray icon should show the local process/server state.

## Current Implementation

The current Windows implementation uses a per-user Startup shortcut rather than
a scheduled task:

- `scripts/windows_install_startup_app.ps1` creates the shortcut and starts the
  tray process immediately if it is not already running.
- `scripts/windows_startup_tray.ps1` owns the `NotifyIcon`, polls `/health`, and
  starts `scripts/windows_run_server.ps1` when the server is dead and the local
  `.venv` exists.
- `scripts/windows_uninstall_startup_app.ps1` removes the shortcut.
- Logs should go under `data\logs\`.

Tray icon contract:

- Base artwork comes from the monochrome template icon, preferring
  `apps\extension\icons\variants\monitor-template-128.png` and falling back to
  smaller source or built `dist` template PNGs.
- Windows tints the template alpha mask dark on light system themes and light on
  dark system themes.
- State overlay uses red for `dead`, gray for `idle`, green for `active`, and
  yellow for `unknown`.
- The tray must not own judging state. It observes and controls the same server
  process; it does not run a separate heavy worker.

Acceptance checks:

- The Startup folder contains `Kibitzer Server.lnk`.
- Logging out/in starts the tray process without a visible terminal.
- `Invoke-RestMethod http://127.0.0.1:8765/health` returns `mode = idle`.
- The tray context menu can refresh status, start the server, open health, and
  quit the tray.

## Future Work

- Add packaging under `packaging/windows/`.
- Decide whether the packaged app bundles Python or expects the repo `.venv`.
- Keep API keys and `configs\models.local.yaml` local-only.
- Preserve manual scripts for development and debugging.
- Consider a scheduled task or packaged app service wrapper if Startup shortcut
  visibility/control becomes insufficient.

## Non-goals

- Do not move Tier 1/Tier 2 logic into the Chrome extension.
- Do not create separate lightweight and heavyweight server programs.
- Do not store provider credentials in the tray app or extension.
- Do not make Windows-only changes inside the shared observation pipeline unless
  a native dependency forces an adapter.

## Open Questions

- Whether restart/stop should control a scheduled task, a child process, or a
  packaged app service wrapper.
- Whether Windows voice should use SAPI later or keep voice disabled until a
  dedicated voice pass.

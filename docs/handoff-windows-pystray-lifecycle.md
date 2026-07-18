# Implementation Record — Windows pystray server lifecycle

## Context

The old Windows tray is a PowerShell `NotifyIcon` wrapper. It polls HTTP on the
UI thread, can leave its menu open or ignore clicks, and has no safe server stop
operation. PR #38 added stop/restart to that wrapper, but its fixed port and
PowerShell-owned lifecycle no longer match the decided PyInstaller distribution.

The packaging foundation landed in PR #100. This document records the separate
Windows lifecycle follow-up implemented in PR #105, which reuses D9's runtime
paths and PyInstaller collection without folding platform-specific tray code
back into the foundation PR.

## Ownership contract

The FastAPI server remains the single source of truth. A server that owns a
candidate port publishes these files in the resolved runtime control directory:

- `server-control.json`: protocol, instance ID, PID, host, selected port, and
  process metadata.
- `server-stop-request.json`: an instance-scoped graceful-shutdown request.

The instance ID returned by `/identity` must equal the ID in the control file.
The server watches the stop request and sets `uvicorn.Server.should_exit` only
when the IDs match. It removes only files that still belong to its own instance.

The tray must verify the control record against `/identity` before requesting a
stop. A stale PID is never sufficient authority to terminate a process. A hard
kill is allowed only for the exact child `Popen` object created by the current
tray process, after graceful shutdown times out.

On Windows, the control directory is shared at
`%LOCALAPPDATA%\Kibitzer\runtime` even in development, while databases and
configuration remain worktree-local. This lets a new worktree tray safely stop
the currently listening old-worktree server. `KIBITZER_HOME` still creates a
fully isolated control directory for tests and parallel profiles.

## Tray contract

- Use `pystray` and Pillow, with blocking `Icon.run()` on the main thread.
- Run health polling and lifecycle actions on background threads.
- Menu callbacks never perform network requests or wait for process exit.
- Update dynamic menu state through `Icon.update_menu()` after state changes.
- Expose status, Start server, Stop server, Restart server, Open logs, and Exit.
- Starting the tray starts the server when no valid Kibitzer identity exists.
- Exiting the tray requests server shutdown; the app owns the server lifecycle.
- A single-instance lock prevents duplicate Windows tray icons.

## Distribution and development

The Windows onedir distribution has one user-facing windowed `Kibitzer.exe` and
an internal console `kibitzer-server.exe` used for diagnostics, smoke tests, and
the server child process. They share one PyInstaller collection. macOS keeps the
existing console `kibitzer` artifact until its native app surface is designed.

Repository development uses `.venv\\Scripts\\pythonw.exe -m
apps.server.app.windows_tray`. Startup shortcuts target the packaged tray when
present and the development module otherwise. The old PowerShell tray is no
longer the active lifecycle implementation.

## Acceptance checks

- Start discovers the selected candidate port and reaches `idle` or `active`.
- Stop and Restart complete without Task Manager and without a fixed port.
- A stale/mismatched control file cannot stop an unrelated or newer process.
- Polling cannot block native tray menu interaction.
- Duplicate tray launches exit without creating a second icon.
- Packaged smoke starts and gracefully stops the server through the control
  protocol on macOS and Windows.
- Server pytest and extension tests/build pass; Windows CI builds both bundled
  executables and runs the packaged smoke test.

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

The modern toast transport, Priority-only fallback, and Windows QA completed on
2026-07-18 are recorded separately in
`docs/handoff-2026-07-18-windows-launch-notifications.md`.

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
- Manual launch and lifecycle actions display modern WinRT notifications under
  the stable current-user `Kibitzer.Tray` AppUserModelID.
- A duplicate manual launch writes an instance-scoped attention request and
  waits for the matching acknowledgement. If the tray is already shutting down
  or does not acknowledge within three seconds, the duplicate process uses its
  own topmost message instead of exiting silently.
- When Windows reports Priority-only or Alarms-only mode, manual startup,
  duplicate launches, and failures also use a topmost message fallback because
  ordinary toast banners are suppressed in those modes.
- A delayed WinRT delivery-failure event invokes the same one-shot fallback;
  no fixed timing window is used to guess whether delivery succeeded.
- Login autostart is quiet on success; startup and lifecycle failures remain
  visible. Automatic `idle`/`active` changes do not produce notification spam.
- Installing autostart removes the retired `Kibitzer Server.lnk` shortcut so
  development and packaged launchers cannot race at the next login.

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
- Duplicate tray launches notify through the existing instance and exit without
  creating a second icon or server; rapid repeated launches are coalesced.
- Manual launch reports startup/status, while `--autostart` suppresses routine
  success notifications and `--smoke` remains non-interactive.
- Packaged smoke starts and gracefully stops the server through the control
  protocol on macOS and Windows.
- Server pytest and extension tests/build pass; Windows CI builds both bundled
  executables and runs the packaged smoke test.

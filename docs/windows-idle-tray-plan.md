# Windows pystray lifecycle

This is the Windows platform surface for the shared FastAPI server. The server
continues to own HTTP state, SQLite state, and runtime mode; the tray owns only
process lifecycle and status presentation.

## States

```text
dead      no valid identity response on any candidate port
starting  a background start operation is in progress
idle      server responds with mode=idle
active    server responds with mode=active
unknown   identity is valid but health mode is unrecognized/unavailable
stopping  a background stop/restart operation is in progress
```

## Implementation

- `apps/server/app/windows_tray.py` uses pystray/Pillow. `Icon.run()` remains on
  the main thread; health polling and Start/Stop/Restart actions run in worker
  threads, so a slow HTTP request cannot block Windows menu clicks or dismissal.
- Dynamic status/enabled menu properties are refreshed with
  `Icon.update_menu()` after state changes.
- The server publishes its selected candidate port and instance-scoped control
  record in the resolved runtime data directory. The `/identity` instance ID
  must match before the tray writes a graceful stop request.
- A PID from a file is never force-killed. Only the exact child process object
  created by the current tray may be terminated after graceful shutdown times
  out.
- A named Windows mutex prevents duplicate tray icons. Uninstall writes an
  instance-scoped tray exit request instead of trusting a reusable PID.
- Logs are stored under the runtime `logs` directory. The status dot is red for
  dead, gray for idle, green for active, and yellow for transitions/unknown.

## Development and packaged launch

`scripts/windows_install_startup_app.ps1` creates a per-user Startup shortcut.
It targets `dist\kibitzer\Kibitzer.exe` when the packaged app exists, otherwise
it targets `.venv\Scripts\pythonw.exe -m apps.server.app.windows_tray`.

The Windows onedir bundle contains:

- `Kibitzer.exe`: the single user-facing, windowed tray launcher.
- `kibitzer-server.exe`: an internal console executable used by the tray and
  available for diagnostics/smoke tests.
- `_internal\`: shared Python dependencies and bundled resources.

The compatibility `windows_startup_tray.ps1` only forwards old shortcuts to the
Python tray and exits; it no longer owns a `NotifyIcon` or native icon handles.

## Acceptance checks

- Login/startup produces one tray icon and no visible terminal.
- Start, Stop, and Restart work on the dynamically selected port.
- Exit stops the server and tray without Task Manager.
- A stale/mismatched control record cannot stop a newer or unrelated process.
- Server tests, extension build, and packaged smoke pass on macOS and Windows.

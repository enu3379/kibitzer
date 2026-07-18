# Idle Daemon Plan

Kibitzer should feel always available without keeping the full judging pipeline
hot all day. The daemon contract is a single local server process with two
runtime modes, plus platform-specific process visibility at the edge.

## State Model

```text
dead    no server process or no HTTP response
idle    HTTP health/session APIs are up; judging resources are cold
active  a goal-backed session is running; judging resources are initialized
unknown identity is valid, but health has no recognized runtime mode
```

The Chrome extension already distinguishes `dead` from HTTP responses by
treating failed requests as unreachable. The server exposes `idle` and `active`
through `GET /health`; native launchers map an unrecognized or unavailable mode
to `unknown` rather than guessing at server state.

## Process Model

Use one FastAPI server worker. A platform UI may launch and supervise that
process, but it must not become another owner of application state.

- Login startup ensures that the same FastAPI server process is running in
  `idle`.
- `idle` initializes only lightweight server state: config, SQLite schema,
  privacy rules, personas, and health/session endpoints.
- The first goal-backed session activates runtime resources: embedding provider
  and Tier 1/Tier 2 judge providers.
- Ending the current session releases those runtime resources and returns to
  `idle`.

This keeps state ownership simple: one server PID owns the HTTP port and runtime
mode. Platform UI may own that process's lifecycle, but it only observes server
state through the shared identity and health contracts.

## macOS Phase

The macOS implementation uses a user LaunchAgent plus a menu bar status item:

- `scripts/macos_install_launch_agent.sh` writes
  `~/Library/LaunchAgents/com.kibitzer.server.plist`.
- The LaunchAgent runs `scripts/macos_run_server.sh` at login.
- stdout/stderr go to `data/logs/`.
- `scripts/macos_uninstall_launch_agent.sh` unloads the LaunchAgent and removes
  the plist.
- `scripts/macos_install_menu_bar_agent.sh` installs a companion menu bar item
  that polls `GET /health` and displays `dead` / `idle` / `active` / `unknown`.

The menu bar item shows server/process state. The Chrome extension badge remains
the browser/extension reachability and intervention-state indicator. See
[macOS Menu Bar Plan](macos-menu-bar-plan.md).

## Windows Phase

Windows uses a pystray app without changing the server's state ownership. The
detailed implementation contract lives in
[Windows Idle Tray Plan](windows-idle-tray-plan.md):

- a current-user Startup shortcut launches the tray at login;
- the tray starts, stops, and restarts the single FastAPI server worker;
- instance-scoped control files and `/identity` verification make shutdown safe
  across stale state and worktree switches;
- the tray maps `dead` to red, `idle` to gray, `active` to green, and
  transitions/`unknown` to yellow;
- keep the extension badge focused on extension-to-server reachability.

The packaged onedir distribution exposes a windowed `Kibitzer.exe` tray and an
internal `kibitzer-server.exe`. The tray supervises the child process but never
owns sessions, judging resources, or controller state.

## Follow-up Work

- Promote the macOS menu bar and server into the D9 app-bundle lifecycle.
- Add platform installers and release automation when they become real
  deliverables.
- Replace the placeholder macOS menu bar title with Claude-owned final artwork.
- Consider an idle timeout for long-lived active sessions only if users need a
  pause state distinct from ending a session.

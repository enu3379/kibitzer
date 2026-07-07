# Idle Daemon Plan

Kibitzer should feel always available without keeping the full judging pipeline
hot all day. The daemon contract is a single local server process with two
runtime modes, plus platform-specific process visibility at the edge.

## State Model

```text
dead    no server process or no HTTP response
idle    HTTP health/session APIs are up; judging resources are cold
active  a goal-backed session is running; judging resources are initialized
```

The Chrome extension already distinguishes `dead` from HTTP responses by
treating failed requests as unreachable. The server exposes `idle` and `active`
through `GET /health` so native launchers, future tray icons, and smoke tests can
show the real process state.

## Process Model

Use one process, not a launcher plus worker pair.

- Login starts the same FastAPI process in `idle`.
- `idle` initializes only lightweight server state: config, SQLite schema,
  privacy rules, personas, and health/session endpoints.
- The first goal-backed session activates runtime resources: embedding provider
  and Tier 1/Tier 2 judge providers.
- Ending the current session releases those runtime resources and returns to
  `idle`.

This keeps lifecycle ownership simple: one PID owns the HTTP port and the
runtime mode. Platform UI should observe this process, not mirror it with a
separate status daemon.

## macOS Phase

The macOS implementation uses a user LaunchAgent:

- `scripts/macos_install_launch_agent.sh` writes
  `~/Library/LaunchAgents/com.kibitzer.server.plist`.
- The LaunchAgent runs `scripts/macos_run_server.sh` at login.
- stdout/stderr go to `data/logs/`.
- `scripts/macos_uninstall_launch_agent.sh` unloads the LaunchAgent and removes
  the plist.

No macOS menu bar icon is required for this phase. The extension badge remains
the primary user-facing connection indicator.

## Windows Phase

Windows should add process visibility later without changing the server core.
The detailed implementation plan lives in
[Windows Idle Tray Plan](windows-idle-tray-plan.md):

- register the same server process as a startup app or scheduled task;
- add a system tray surface that queries `GET /health`;
- map `dead` to warning, `idle` to gray, and `active` to color;
- keep the extension badge focused on extension-to-server reachability.

The tray process may be the same Python entrypoint if packaged that way, but it
should not become a second worker that owns judging state.

## Follow-up Work

- Add packaging entries under `packaging/macos/` and `packaging/windows/` when
  installers become real deliverables.
- Add Windows startup/tray implementation from
  [Windows Idle Tray Plan](windows-idle-tray-plan.md).
- Consider an idle timeout for long-lived active sessions only if users need a
  pause state distinct from ending a session.

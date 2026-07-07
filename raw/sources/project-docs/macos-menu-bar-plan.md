# macOS Menu Bar Plan

This is the macOS counterpart to the Windows tray work in PR #2. The menu bar app
is a process/status surface, not a second server.

## Contract

The menu bar app observes:

```text
GET http://127.0.0.1:8765/health
```

State mapping:

```text
dead     health request fails
idle     health returns mode=idle
active   health returns mode=active
unknown  health responds without a known mode
```

The menu bar surface owns only visibility and light process control:

- show the current state in the macOS menu bar;
- poll health every 10 seconds;
- kick `com.kibitzer.server` if the server is dead;
- fall back to `scripts/macos_run_server.sh` when the server LaunchAgent is not
  installed;
- open the health endpoint and logs folder.

It must not own sessions, judgments, provider credentials, or controller state.

## Implementation

Current prep implementation:

- `apps/menubar/macos/KibitzerMenuBar.swift`
- `scripts/macos_build_menu_bar.sh`
- `scripts/macos_run_menu_bar.sh`
- `scripts/macos_install_menu_bar_agent.sh`
- `scripts/macos_uninstall_menu_bar_agent.sh`

The Swift app uses `NSStatusItem` directly, so it does not add a Python GUI
dependency. It currently renders a placeholder `K ●` status item.

## Design Handoff

Claude owns the visual treatment. The runtime contract to preserve:

- states: `dead`, `idle`, `active`, `unknown`;
- menu actions: refresh, start server, open health, open logs, quit;
- server state source: `/health`;
- no duplicated judging state.

Open visual decisions:

- final menu bar icon shape;
- whether to use a monochrome template icon plus colored dot, or separate state
  assets;
- tooltip/menu copy polish;
- whether the active state should use a subtle animation or stay static.

Suggested asset location if static assets are chosen:

```text
apps/menubar/macos/assets/
```

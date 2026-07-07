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
dependency. It loads the monochrome template icon from
`apps/extension/icons/variants/monitor-template-128.png`, marks it as an AppKit
template image, and shows a small state dot next to it. If the template icon
asset is unavailable in a source checkout, it falls back to a text-only `K ●`
status item.

## Design Handoff

Claude owns the shared icon artwork. The runtime contract to preserve:

- states: `dead`, `idle`, `active`, `unknown`;
- menu actions: refresh, start server, open health, open logs, quit;
- server state source: `/health`;
- no duplicated judging state.

Current visual contract:

- native template source: `apps/extension/icons/variants/monitor-mono.svg`;
- menu bar runtime asset: `apps/extension/icons/variants/monitor-template-128.png`;
- macOS light/dark tinting: handled by `NSImage.isTemplate`;
- state dot: gray idle, green active, red dead, yellow unknown.

Open visual decisions are limited to final status-dot placement/treatment,
tooltip/menu copy polish, and whether active should animate or remain static.

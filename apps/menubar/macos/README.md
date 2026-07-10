# Kibitzer macOS Menu Bar

This Swift menu bar app mirrors the Windows tray surface:

- polls `http://127.0.0.1:8765/health`;
- shows `dead`, `idle`, `active`, or `unknown` in the macOS menu bar;
- can kick the server LaunchAgent or fall back to `scripts/macos_run_server.sh`;
- opens the logs folder from the menu.

The status item uses the monochrome template icon at
`apps/extension/icons/variants/monitor-v1-mono-128.png` and renders it as an
AppKit template image so macOS handles light/dark menu bar tinting. The menu bar
app owns only the runtime state dot.

State colors:

- gray: server is alive and idle;
- green: an active monitoring session is running;
- red: the server is unreachable;
- yellow: the server responded with an unknown mode.

If the template icon asset is missing, the app falls back to a text-only `K`
plus a colored dot so the runtime still remains usable from source checkouts.

Build/run:

```bash
bash scripts/macos_build_menu_bar.sh
bash scripts/macos_run_menu_bar.sh
```

If Swift reports an unsupported SDK/compiler mismatch, update or reinstall Xcode
Command Line Tools. The build script keeps Swift module cache output under
`apps/menubar/macos/build/` so normal builds do not write outside the repo.

# Kibitzer macOS Menu Bar

This Swift menu bar app mirrors the Windows tray surface:

- polls `http://127.0.0.1:8765/health`;
- shows `dead`, `idle`, `active`, or `unknown` in the macOS menu bar;
- can kick the server LaunchAgent or fall back to `scripts/macos_run_server.sh`;
- opens the health endpoint and logs folder from the menu.

The status item uses the shared Chrome extension icon at
`apps/extension/icons/icon-128.png` and overlays a small state dot. The extension
icon remains the shared artwork source of truth; the menu bar app owns only the
runtime state treatment.

State colors:

- gray: server is alive and idle;
- green: an active monitoring session is running;
- red: the server is unreachable;
- yellow: the server responded with an unknown mode.

If the icon asset is missing, the app falls back to a text-only `K` plus a
colored dot so the runtime still remains usable from source checkouts.

Build/run:

```bash
bash scripts/macos_build_menu_bar.sh
bash scripts/macos_run_menu_bar.sh
```

If Swift reports an unsupported SDK/compiler mismatch, update or reinstall Xcode
Command Line Tools. The build script keeps Swift module cache output under
`apps/menubar/macos/build/` so normal builds do not write outside the repo.

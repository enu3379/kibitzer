# Kibitzer macOS Menu Bar

This Swift menu bar app mirrors the Windows tray surface:

- polls `http://127.0.0.1:8765/health`;
- shows `dead`, `idle`, `active`, or `unknown` in the macOS menu bar;
- can kick the server LaunchAgent or fall back to `scripts/macos_run_server.sh`;
- opens the health endpoint and logs folder from the menu.

Icon artwork is intentionally not final here. The current status item uses a
text placeholder (`K` plus a colored dot) so Claude can replace the visual
treatment without changing the runtime contract.

Build/run:

```bash
bash scripts/macos_build_menu_bar.sh
bash scripts/macos_run_menu_bar.sh
```

If Swift reports an unsupported SDK/compiler mismatch, update or reinstall Xcode
Command Line Tools. The build script keeps Swift module cache output under
`apps/menubar/macos/build/` so normal builds do not write outside the repo.

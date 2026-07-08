# Handoff: Windows tray "Start server" gives no feedback and appears dead (issue #11, tray half)

Date: 2026-07-08
Scope owner: delegated agent (Codex).
Branch: `codex/windows-tray-start-server`
(worktree: `/Users/eunu03/kibitzer-worktrees/windows-tray-start-server`).
Parent: [issue #11](https://github.com/enu3379/kibitzer/issues/11). The other
half of that issue (extension popup must open with a warning banner when the
server is down) is a separate branch, `feature/popup-server-offline` — do NOT
touch `apps/extension` here.

## Why this exists

Tester evidence (video on the issue): tray icon shows the red dead dot, the
tester clicks **Start server**, and 10+ seconds later (at least one poll cycle)
the tooltip still reads "Kibitzer: not running"; the Chrome extension keeps
saying the server is not connected.

Every failure path in `Start-KibitzerServer`
([windows_startup_tray.ps1:70](../scripts/windows_startup_tray.ps1)) is
silent:

1. `.venv\Scripts\python.exe` missing → bare `return`. Clicking the menu item
   literally does nothing — no balloon, no log line. On a machine where
   `windows_setup.ps1` was never run (or failed partway), this exactly
   reproduces the video.
2. The server is spawned fire-and-forget (`Start-Process` on a hidden
   `windows_run_server.ps1`). If uvicorn dies at boot (port 8765 already
   bound, broken deps, bad `.env`/config), the traceback lands only in
   `data\logs\windows-startup-app.err.log`; the tray just stays red.
3. The click handler sleeps 500 ms and refreshes once. A healthy boot takes a
   few seconds, so even a *successful* start looks dead until the next 10 s
   poll tick.

We cannot reproduce remotely (dev machine is macOS; no tester logs yet), so
the fix is **observability + robustness**, not a guess at the one true root
cause: every failure must tell the user what happened and where to look, and
a successful start must show up within a second of the server answering.

## Required changes

All in [scripts/windows_startup_tray.ps1](../scripts/windows_startup_tray.ps1)
unless noted.

### 1. Loud precondition failures

When `.venv\Scripts\python.exe` is missing, show a balloon tip
(`$NotifyIcon.ShowBalloonTip`) — title `Kibitzer`, text
`Python venv not found. Run scripts\windows_setup.ps1 first.` — and write a
tray-log line. Same treatment if `$RunScript` itself is missing. Never bare
`return` out of a user-initiated action.

### 2. Non-blocking "starting" state with a deadline

Do NOT `Start-Sleep`-loop inside a click handler: the tray is a single-thread
WinForms STA app and sleeping blocks the message pump (menu and icon freeze).
Model startup as state driven by the existing `System.Windows.Forms.Timer`:

- Script-scope state, e.g. `$Script:StartingUntil` (deadline = now + 30 s) and
  `$Script:StartSource` (`auto` | `menu`), set at spawn time. Capture the
  spawned wrapper process with `Start-Process -PassThru` into
  `$Script:StartProcess` and log its pid.
- While starting: tray text `Kibitzer: starting...`, icon `unknown` (yellow),
  timer interval dropped to 1000 ms; the **Start server** menu item disabled
  (prevents double spawns; the existing health-based early return stays as a
  second guard).
- Timer tick resolves the state — and this ordering matters: the tick handler
  must branch on the starting state FIRST so `Update-KibitzerTray` does not
  clobber "starting..." with "not running" mid-boot:
  - health answers → clear starting state, restore interval/menu item, update
    icon as today; show a success balloon (`Kibitzer server is running.`) only
    when `$StartSource` is `menu` — no balloon spam at every logon.
  - wrapper process has exited AND health still dead → fail fast (don't wait
    out the deadline).
  - deadline passed, still dead → clear starting state, balloon
    `Server failed to start. See data\logs\windows-startup-app.err.log (menu > Open logs).`,
    and append the last ~5 lines of the err log to the tray log for
    postmortems.
- `NotifyIcon.Text` has a hard 63-char limit — keep all tooltip strings short.

### 3. "Open logs" menu item

New item between **Open health** and **Exit tray**; opens `$LogDir` in
Explorer (`Start-Process explorer.exe $LogDir`). This is the escape hatch every
failure balloon points at.

### 4. Logon-time auto start goes through the same path

The bare `Start-KibitzerServer` call at tray launch
([windows_startup_tray.ps1:183](../scripts/windows_startup_tray.ps1)) must set
the same starting state (`$StartSource = 'auto'`), so a failed logon autostart
produces the same failure balloon and log tail — today it fails invisibly.

### 5. Log every attempt

Each start attempt writes to `windows-startup-tray.log` via the existing
`Write-TrayLog`: source (`auto`/`menu`), spawned pid, and outcome
(`health-ok after Ns` | `wrapper-exited` | `timeout` | `precondition-failed:
<reason>`).

### 6. Docs

Update the tray paragraph in [WINDOWS_SETUP.md](../WINDOWS_SETUP.md): the
starting state, the failure balloons, and the **Open logs** menu item.

## Constraints

- Target is Windows PowerShell 5.1 (`powershell.exe`) — no PS 7-only syntax
  (no `??`, no ternary). Single-file script, no new dependencies, no
  background jobs/runspaces; the one timer is enough.
- All user-visible strings (balloons, tooltips, menu items) stay plain ASCII
  English, matching the existing menu (the file is BOM-less and 5.1 mangles
  non-ASCII literals).
- Preserve existing behavior otherwise: single-instance mutex, pid file, icon
  tinting/theme handling, 10 s poll default, `Refresh status` / `Open health`
  / double-click behavior.
- Do not modify `windows_run_server.ps1` semantics (its log redirection is
  what the balloons point at), the installer/uninstaller, or anything under
  `apps/`.

## Acceptance

- **Parse check (this Mac has no pwsh preinstalled):** `brew install --cask
  powershell`, then confirm zero parse errors:

  ```bash
  pwsh -NoProfile -Command '$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile("scripts/windows_startup_tray.ps1",[ref]$t,[ref]$e)|Out-Null;$e'
  ```

  Empty output = clean. WinForms does not exist on macOS, so runtime testing
  locally is impossible — the parse check plus careful desk-check is the bar.
- **Manual Windows checklist** (include verbatim in the PR description for the
  tester):
  1. Rename `.venv` → **Start server** → balloon points at
     `windows_setup.ps1`; nothing spawned.
  2. Occupy port 8765 (`python -m http.server 8765`) → **Start server** →
     "starting..." then a failure balloon well within ~35 s; err log names the
     bind error; **Open logs** opens the folder.
  3. Normal machine → **Start server** → "starting..." → icon leaves red
     within a few seconds of the server answering; success balloon shown.
  4. Logon autostart still works; failures balloon, successes stay quiet.
- PR references issue #11 and asks the tester to retry and attach
  `data\logs\windows-startup-tray.log` and
  `data\logs\windows-startup-app.err.log` if anything still fails.
- progress.md entry (append, matching its existing format).

## Non-goals

- No port-conflict auto-resolution, no killing/restarting stray processes —
  report, don't heal.
- No changes to server code, installer scripts, or health endpoint.
- No Chrome extension changes (that is `feature/popup-server-offline`).
- No tray feature additions beyond the issue scope (no settings UI, no
  autostart toggle).

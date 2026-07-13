# Kibitzer Windows Setup

This package is prepared for Windows transfer. It intentionally excludes the
Mac virtualenv, Mac npm install output, Python caches, and the local SQLite
runtime database.

## Requirements

- Windows 10 or 11
- Python 3.11 or newer, preferably 3.11 or 3.12
- Node.js LTS with npm
- Google Chrome

## First Setup

Open PowerShell in this folder and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows_setup.ps1
```

The script creates `.venv`, installs Python dependencies, installs extension
npm dependencies, and rebuilds `apps\extension\dist`.

## Run

Start the local server:

```powershell
.\scripts\windows_run_server.ps1
```

Then load the Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `apps\extension\dist`.

## Optional Login Autostart

Install a current-user Startup shortcut so the server starts at Windows logon in
idle mode and shows a taskbar tray icon:

```powershell
.\scripts\windows_install_startup_app.ps1
```

The server responds to health checks while idle, but judging providers are
initialized only after a goal-backed session starts. Check the mode with:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

Remove the Startup shortcut with:

```powershell
.\scripts\windows_uninstall_startup_app.ps1
```

Startup logs are written under `data\logs\`. The tray icon polls
`GET /health`: red means unreachable, gray means idle, green means active, and
yellow means unknown or starting. Health checks run asynchronously so an
unreachable server does not block the tray menu. The status header reports
missing setup, startup failures, and timeouts; **Open logs** opens the folder
containing the tray and server startup logs. The icon uses the monochrome template artwork,
tinted for the current Windows system theme, with a small status dot overlay.
Selecting **Refresh status** starts a new health check and keeps the tray menu
open so the updated status can be inspected without reopening it.

The tray menu has one server control item: it shows **Start server** while the
server is down and changes to **Stop server** after startup succeeds. Stop
requests are handled by the Windows server host so Uvicorn can shut down
gracefully; if that times out, the tray force-stops only a process whose
executable, command line, project path, start time, and instance record all
match this Kibitzer checkout. **Exit tray** closes only the tray surface and
leaves the server running.

## Optional AI Provider Setup

Copy the example env file:

```powershell
Copy-Item .env.example .env
```

Fill `ollama1` and `ollama2` (and optionally `ollama3` — with 2+ keys each
tier rotates across all of them) in `.env` with your Ollama Cloud API keys
(one-time — every later start picks them up automatically). For model
routing, copy:

```powershell
Copy-Item configs\experiment-models.example.yaml configs\models.local.yaml
```

Edit `configs\models.local.yaml` if you want different models (Ollama Cloud
`nemotron-3-super` / `minimax-m3` by default; self-hosted Ollama also works). The real
`.env` file and `configs\models.local.yaml` are ignored by git. If provider
settings are incomplete, Kibitzer still runs with local Tier 0 scoring and
fallback messages; the server records provider degradation when a goal-backed
session first activates those providers.

## Notes

- Do not copy `.venv` or `node_modules` between macOS and Windows.
- `data\kibitzer.sqlite3` is created on first server start.
- The current voice feature uses the macOS `say` command; leave voice off on
  Windows unless a Windows speech backend is added.

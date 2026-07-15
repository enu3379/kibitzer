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

The script creates `.venv`, installs Python dependencies, downloads and verifies
the local Tier 0 ONNX model plus tokenizer (about 41 MB total), installs
extension npm dependencies, and rebuilds `apps\extension\dist`.

The model files are stored under ignored `data\models\`. To verify them later
without downloading again:

```powershell
.\.venv\Scripts\python.exe scripts\download_embedding_model.py --check
```

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

On the first server start, copy the 64-character code printed in the server log
(also stored temporarily in `data\pairing.code`) into the extension popup. The
file is removed after successful pairing. If the browser loses its pairing key,
stop the server, run `.\.venv\Scripts\python.exe scripts\reset_pairing.py`,
restart the server, and pair again.

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
yellow means unknown or starting. The status header reports missing setup,
startup failures, and timeouts; **Open logs** opens the folder containing the
tray and server startup logs. The icon uses the monochrome template artwork,
tinted for the current Windows system theme, with a small status dot overlay.

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
- Setup and launch replace inherited ACLs for `data\`, `.env`, and
  `configs\models.local.yaml` with a current-user-only ACL.
- The current voice feature uses the macOS `say` command; leave voice off on
  Windows unless a Windows speech backend is added.

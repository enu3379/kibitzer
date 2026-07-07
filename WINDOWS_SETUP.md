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

## Optional AI Provider Setup

Copy the example env file:

```powershell
Copy-Item .env.example .env
```

Fill `ollama1` and `ollama2` in `.env`. For local model routing, copy:

```powershell
Copy-Item configs\experiment-models.example.yaml configs\models.local.yaml
```

Edit `configs\models.local.yaml` for your local or cloud endpoint. The real
`.env` file and `configs\models.local.yaml` are ignored by git. If provider
settings are incomplete, Kibitzer still runs with local Tier 0 scoring and
fallback messages; startup logs will mention provider degradation.

## Notes

- Do not copy `.venv` or `node_modules` between macOS and Windows.
- `data\kibitzer.sqlite3` is created on first server start.
- The current voice feature uses the macOS `say` command; leave voice off on
  Windows unless a Windows speech backend is added.

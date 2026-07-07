# Kibitzer macOS Setup

Kibitzer is intended to run from the same repository on macOS and Windows.
The server and Chrome extension code are shared; only setup and launch scripts
are platform-specific.

## Requirements

- macOS 13 or newer
- Python 3.11 or newer, preferably 3.12
- Node.js LTS with npm
- Google Chrome

## First Setup

Open Terminal in this folder and run:

```bash
bash scripts/macos_setup.sh
```

The script creates `.venv`, installs Python dependencies, installs extension
npm dependencies, and rebuilds `apps/extension/dist`.

## Run

Start the local server:

```bash
bash scripts/macos_run_server.sh
```

Then load the Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `apps/extension/dist`.

## Optional AI Provider Setup

Copy the example env file:

```bash
cp .env.example .env
```

Fill `ollama1` and `ollama2` in `.env`. For local model routing, copy:

```bash
cp configs/experiment-models.example.yaml configs/models.local.yaml
```

Edit `configs/models.local.yaml` for the local or cloud endpoint. The real
`.env` file and `configs/models.local.yaml` are ignored by git.

## Notes

- Do not copy `.venv` or `node_modules` between macOS and Windows.
- `data/kibitzer.sqlite3` is created on first server start.
- The current voice feature uses the macOS `say` command, so voice can work on
  macOS once enabled in settings.

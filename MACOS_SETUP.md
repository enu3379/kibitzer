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

## Optional Login Autostart

Install a user LaunchAgent so the server starts at login in idle mode:

```bash
bash scripts/macos_install_launch_agent.sh
```

The server responds to health checks while idle, but judging providers are
initialized only after a goal-backed session starts. Check the mode with:

```bash
curl http://127.0.0.1:8765/health
```

Remove the LaunchAgent with:

```bash
bash scripts/macos_uninstall_launch_agent.sh
```

LaunchAgent logs are written under `data/logs/`.

## Optional Menu Bar Status

Install the macOS menu bar status item so the server state is visible next to
the clock:

```bash
bash scripts/macos_install_menu_bar_agent.sh
```

The menu bar item polls `GET /health`: red means unreachable, gray means idle,
green means active, and yellow means unknown. It uses the monochrome template
icon so macOS handles light/dark menu bar tinting.

Remove the menu bar item with:

```bash
bash scripts/macos_uninstall_menu_bar_agent.sh
```

Menu bar logs are written under `data/logs/`.

## Optional AI Provider Setup

Copy the example env file:

```bash
cp .env.example .env
```

Fill `ollama1` and `ollama2` in `.env` with your Ollama Cloud API keys
(one-time — every later start picks them up automatically). For model
routing, copy:

```bash
cp configs/experiment-models.example.yaml configs/models.local.yaml
```

Edit `configs/models.local.yaml` if you want different models (Ollama Cloud
`nemotron-3-super` / `minimax-m3` by default; self-hosted Ollama also works). The real
`.env` file and `configs/models.local.yaml` are ignored by git.

## Notes

- Do not copy `.venv` or `node_modules` between macOS and Windows.
- `data/kibitzer.sqlite3` is created on first server start.
- The current voice feature uses the macOS `say` command, so voice can work on
  macOS once enabled in settings.

# Kibitzer

Kibitzer is a local, non-blocking attention guard. A user declares a goal, the system observes browser navigation, and it only comments when drift from the declared goal accumulates.

Stage 0 is intentionally narrow:

- Chrome navigation observations only.
- One active session has one declared goal.
- Embedding is local CPU-only.
- Tier 1 and Tier 2 use configurable judge APIs — Ollama Cloud by default
  (OpenAI-compatible endpoints also supported).
- Raw page body is requested only immediately before an intervention.
- All interventions are non-blocking: an in-page toast on the active browsing
  surface, redisplayed while pending after tab switches (system notifications
  only as a fallback). The app never blocks browsing or typing.

## Core Contract

The source-specific layer ends at `Observation`.

```text
Source Adapter -> Observation -> Relevance -> Tier Cascade -> Controller -> Delivery
```

The local server is the single source of truth for session state. The Chrome MV3 service worker is only an event relay.

## Repository Layout

```text
configs/             Runtime knobs and privacy lists
docs/                Design docs split by implementation concern
apps/server/         Python FastAPI local server
apps/extension/      Chrome MV3 extension
data/                Local runtime data, ignored by git
scripts/             Platform setup, run, smoke, and maintenance scripts
```

## Cross-platform Setup

Kibitzer is one repository for both macOS and Windows. The server and extension
code are shared; setup, launch, and future packaging live in OS-specific files.

- Windows: see [WINDOWS_SETUP.md](WINDOWS_SETUP.md)
- macOS: see [MACOS_SETUP.md](MACOS_SETUP.md)
- Platform policy: see [docs/platforms.md](docs/platforms.md)

For AI provider keys, copy `.env.example` to `.env` and keep the real `.env`
local. Local model routing belongs in `configs/models.local.yaml`, which is also
ignored by git.

The installed server entry point supports these diagnostics and launch forms:

```text
kibitzer              Start the local server
kibitzer serve        Start the local server explicitly
kibitzer paths        Print resolved config/data/resource paths as JSON
kibitzer --version    Print the application version
```

Source runs resolve `configs/`, `.env`, and `data/` from the repository rather
than the current shell directory. Packaged builds use the OS user-data
directory for writable state. `KIBITZER_HOME` overrides writable paths and
`KIBITZER_CONFIG` selects a different main config file.

The current unsigned onedir package and its executable smoke test are documented
in [packaging/README.md](packaging/README.md). Windows includes the windowed tray
app and its bundled server; macOS app-bundle/menu-bar integration remains a
follow-up. Manual Windows launches show a WinRT status notification, with a
topmost fallback when Windows is suppressing ordinary banners; login autostart
stays quiet unless startup fails. Launching the app again signals the existing
tray instead of creating a duplicate icon or server.

## Implementation Defaults

```text
Embedding  KoEn E5 Tiny qint8 ONNX, local CPU-only, no CUDA requirement
Tier 1     fast cloud classifier (Ollama Cloud; OpenAI-compatible supported)
Tier 2     stronger cloud confirmation/message judge (Ollama Cloud)
Storage    SQLite
Server     Python + FastAPI
Extension  TypeScript MV3
```

## LLM Wiki Usage

This project root is also an LLM Wiki project. It contains:

```text
purpose.md
schema.md
wiki/
raw/sources/
.llm-wiki/
```

The working contract is documented in [docs/llm-wiki-integration.md](docs/llm-wiki-integration.md). Stable docs are copied into `raw/sources/project-docs/` as LLM Wiki source snapshots; edit the canonical files in the repo root and `docs/`.

Refresh those snapshots after adding new durable README/docs files:

```bash
bash scripts/sync-llm-wiki-sources.sh
```

Refresh generated code search sources after adding or changing important code:

```bash
bash scripts/sync-llm-wiki-code-sources.sh
```

Refresh both documentation snapshots and generated code-search pages:

```bash
bash scripts/refresh-llm-wiki-context.sh
```

Search the registered Kibitzer project through the local LLM Wiki API:

```bash
node scripts/llm-wiki-search.mjs "StreakController should_intervene" 5
```

Search runs are logged under `.llm-wiki/runs/search/`. The current operating
mode keeps LLM Wiki API/MCP enabled for project lookup while Source Watch and
auto-ingest stay disabled to avoid surprise LLM spend.

## Local Judgment Review

To inspect the complete Tier-0 → Tier-1 → Tier-2 judgment trail and apply
page-fact labels across recorded sessions:

```bash
.venv/bin/python scripts/judgment_review.py
```

Then open `http://127.0.0.1:8799`. The tool reads the same SQLite database the
app server uses (resolved via the shared runtime paths) and binds to loopback
only; do not expose this port because titles and goals are private browsing
data. Labels on the active session go through the Kibitzer app server so
related-page exemplar learning and D8 verdict propagation stay consistent with
the extension. Labels on past sessions are record-only page-facts
(`sync_exemplar=False`) and never mutate historical exemplars or replay
semantics. Use `--db`, `--port`, or `--app-server` to override the defaults.

## Current Status

The Stage 0 loop is implemented end to end: sessions and declared goals,
dwell-gated browser navigation intake, privacy gates, CPU-only Tier 0,
Tier 1/Tier 2 judging, the controller/request-excerpt handshake, in-page toast
delivery with feedback and active-tab redisplay (system notifications as
fallback), popup
controls/settings/reports, the P1 attachment loop (return celebration, "5분만"
break, custom personas, report APIs, judgment transparency), and a session
lifecycle API (state, stats, snooze, end). The local server starts in idle mode
and activates judging resources only when a goal-backed session starts; macOS
runs it at login via LaunchAgent, Windows via the startup tray. Replay and the
packaged server foundation are implemented; macOS app-bundle integration and
the remaining release/onboarding work stay on the D9 distribution track. See
[docs/progress.md](docs/progress.md) for the detailed log.

# Kibitzer

Kibitzer is a local, non-blocking attention guard. A user declares a goal, the system observes browser navigation, and it only comments when drift from the declared goal accumulates.

Stage 0 is intentionally narrow:

- Chrome navigation observations only.
- One active session has one declared goal.
- Embedding is local CPU-only.
- Tier 1 and Tier 2 use configurable commercial low-cost / stronger OpenAI-compatible APIs.
- Raw page body is requested only immediately before an intervention.
- All interventions are notifications. The app never blocks browsing or typing.

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
```

## Implementation Defaults

```text
Embedding  local CPU-only provider, no CUDA requirement
Tier 1     cheap OpenAI-compatible classifier API
Tier 2     stronger OpenAI-compatible confirmation/message API
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

The working contract is documented in [docs/llm-wiki-integration.md](docs/llm-wiki-integration.md). Stable docs are exposed to LLM Wiki through symlinks in `raw/sources/project-docs/`, so the repo keeps one canonical copy of each document.

Refresh those links after adding new durable README/docs files:

```bash
bash scripts/sync-llm-wiki-sources.sh
```

Refresh generated code search sources after adding or changing important code:

```bash
bash scripts/sync-llm-wiki-code-sources.sh
```

Refresh both documentation links and generated code-search pages:

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

## Current Status

The Stage 0 loop is implemented end to end: sessions and declared goals, browser navigation intake, privacy gates, CPU-only Tier 0, Tier 1/Tier 2 judging, the controller/request-excerpt handshake, Chrome notifications with feedback, and a session lifecycle API (state, stats, snooze, end). The extension bundles to a loadable `apps/extension/dist/` via esbuild, ships PNG icons, and shows a toolbar badge for no-goal/snoozed/unreachable states. Next steps are the popup UI and the Work Package 10 replay CLI. See [docs/progress.md](docs/progress.md) for the detailed log.

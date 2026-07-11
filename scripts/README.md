# Scripts

Project maintenance scripts live here.

## Platform entrypoints

- `windows_setup.ps1` / `windows_run_server.ps1`: Windows setup and server run.
- `windows_install_startup_app.ps1` / `windows_uninstall_startup_app.ps1`:
  optional Windows login autostart for the idle daemon server.
- `windows_startup_tray.ps1`: Windows tray status surface for the autostarted
  server; it uses the monochrome template icon with a state dot overlay.
- `macos_setup.sh` / `macos_run_server.sh`: macOS setup and server run.
- `macos_install_launch_agent.sh` / `macos_uninstall_launch_agent.sh`: optional
  macOS login autostart for the idle daemon server.
- `macos_build_menu_bar.sh` / `macos_run_menu_bar.sh`: build and run the macOS
  menu bar status item.
- `macos_install_menu_bar_agent.sh` / `macos_uninstall_menu_bar_agent.sh`:
  optional macOS login autostart for the menu bar status item.

The application code is shared across operating systems. Keep platform
differences in these entrypoints unless a native adapter is unavoidable.

## Tier 0 embedding

`download_embedding_model.py` downloads the pinned KoEn E5 Tiny qint8 ONNX
model and original tokenizer into ignored `data/models/`, verifies SHA-256, and
is idempotent. Both platform setup scripts call it automatically.

```bash
python scripts/download_embedding_model.py
python scripts/download_embedding_model.py --check
```

`smoke_onnx_embedding.py` prints every fixed Korean, English, and cross-language
similarity case plus cold/warm latency:

```bash
python scripts/smoke_onnx_embedding.py
```

`benchmark_tier0_embeddings.py` evaluates hash and ONNX on the fixed 200-pair
dataset with no cross-validation. It selects the highest-recall threshold at
empirical FPR budgets of 5%, 10%, 15%, 20%, and 30%, and writes all pair scores,
tables, JSON, and an ROC SVG:

```bash
python scripts/benchmark_tier0_embeddings.py
```

The committed benchmark snapshot is under `docs/benchmarks/tier0-embedding/`.

## `sync-llm-wiki-sources.sh`

Refreshes copied snapshots under `raw/sources/project-docs/` for stable project documents.

This lets LLM Wiki ingest documentation while canonical files stay in the repo
root, `docs/`, and module README locations.

The script intentionally does not expose every source code file. Code is summarized through folder README files and curated wiki pages to avoid noisy graph output.
Dependency/build folders such as `node_modules`, `dist`, and `build` are pruned.

## `sync-llm-wiki-code-sources.sh`

Creates generated markdown snapshots under both:

- `raw/sources/code-files/` for source trace/debug.
- `wiki/code/` for llm-wiki API keyword search.

Use this when Codex should be able to use LLM Wiki search to find code symbols or implementation details. The graph should still use module-level wiki pages rather than one graph node per raw file.

## `refresh-llm-wiki-context.sh`

Runs both LLM Wiki sync scripts and prints the refreshed source counts.

```bash
bash scripts/refresh-llm-wiki-context.sh
```

Use this after ordinary implementation work before asking Codex to search the Kibitzer project through LLM Wiki.

## `llm-wiki-search.mjs`

Small Codex-facing helper around the local LLM Wiki API.

```bash
node scripts/llm-wiki-search.mjs "StreakController should_intervene" 5
```

It reads the local API token from LLM Wiki app-state and searches the registered Kibitzer project.

Each invocation writes a compact JSON run log under `.llm-wiki/runs/search/`.
The log includes query, timestamp, result paths/titles/scores/snippets, and status. It never writes the API token.

## `smoke_privacy_gate.py`

Runs the Work Package 4 success/failure smoke scenarios against a running local server:

```bash
.venv/bin/python scripts/smoke_privacy_gate.py
```

It creates a session, verifies that an allowed browser navigation is stored, and verifies that a sensitive navigation is dropped with only minimal event-log metadata.

## `smoke_tier0.py`

Runs the Work Package 5 Tier 0 smoke scenarios against a running local server:

```bash
.venv/bin/python scripts/smoke_tier0.py
```

It creates a session, declares a goal, checks an OK observation, checks a DRIFT observation, and verifies that only OK observations contribute anchor embeddings.

## `smoke_tier1.py`

Runs the Work Package 6 Tier 1 smoke scenarios in process with a fake judge provider:

```bash
.venv/bin/python scripts/smoke_tier1.py
```

It verifies Tier 1 escalation, minimized judge payloads, and Tier 1 event logging without making external API calls.

## `smoke_controller.py`

Runs the Work Package 7 controller handshake smoke scenarios in process:

```bash
.venv/bin/python scripts/smoke_controller.py
```

It verifies that a DRIFT streak returns `request_excerpt`, that cooldown blocks repeated requests, and that controller state is persisted.

## `smoke_tier2_dataset.py`

Runs the Work Package 8 Tier 2 scenario dataset in process with a scripted judge provider:

```bash
.venv/bin/python scripts/smoke_tier2_dataset.py
```

The dataset covers 30 cases: confirmed drift notifications, false-positive cancellations, provider-unavailable fallback, minimized payload checks, and raw-excerpt non-persistence.

## `smoke_tier2_provider_config.py`

Verifies that Tier 2 provider settings can be loaded from `configs/default.yaml` and the experiment model file without printing API keys:

```bash
.venv/bin/python scripts/smoke_tier2_provider_config.py
.venv/bin/python scripts/smoke_tier2_provider_config.py --call
```

The `--call` form sends one real Ollama Cloud request using the configured model and key source.

## `smoke_tier2_http_real.py`

Runs a real HTTP end-to-end smoke against a running Kibitzer server:

```bash
.venv/bin/python scripts/smoke_tier2_http_real.py
```

It creates a session, drives a drift streak until `request_excerpt`, posts an excerpt, verifies that the real Tier 2 provider returns `notify`, and checks that the raw excerpt marker is not persisted.

## `smoke_feedback.py`

Runs the Work Package 9 feedback loop smoke in process:

```bash
.venv/bin/python scripts/smoke_feedback.py
```

It verifies that `related` adds an exemplar and makes the next similar page OK, `accepted` marks the intervention, `snooze` blocks the next intervention while preserving observation logging, and raw excerpt markers are not persisted.

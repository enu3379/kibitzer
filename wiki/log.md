# Kibitzer Research Log

## [2026-07-03] setup | Project-root LLM Wiki integration

- Created Kibitzer repository scaffold.
- Confirmed the existing LLM Wiki API is running at `127.0.0.1:19828` with auth enabled.
- Chose direct project-root integration instead of copying docs into the existing Obsidian vault.
- Added `purpose.md`, `schema.md`, `wiki/`, and `raw/sources/` to the Kibitzer project root.

## [2026-07-03] setup | API registry, search, graph, and model test

- Registered `<kibitzer-project-root>` in the local LLM Wiki project registry.
- Added generated `wiki/code/` snapshots so LLM Wiki API search can find code symbols.
- Added module-level code map pages to connect code files back to architecture concepts in the graph.
- Verified LLM Wiki API `projects`, `search`, and `graph` calls against the Kibitzer project id.
- Tested Billing AI model setup: `gpt-5.4-mini` was absent from the catalog, so active config was set to `gpt-5-4` with reasoning `medium`; minimal chat completion returned `ok`.

## [2026-07-03] implementation | Local server basics

- Added SQLite schema creation for sessions, goals, goal exemplars, observations, controller state, interventions, feedback, and event log.
- Added `POST /sessions`, `GET /sessions/current`, and `POST /sessions/current/goal`.
- Added repository tests for active-session rotation and declared-goal upsert behavior.
- Fixed Python package discovery so editable installs only include `apps.server*`.
- Installed test dependencies in `.venv` and verified the FastAPI OpenAPI paths for the new session endpoints.

## [2026-07-03] implementation | Browser observation intake

- Added `POST /observations/browser-nav` with `PipelineResult(action="none")` responses.
- Added browser navigation normalization from raw URL/title/tab id to host, path hash, title, and tab id.
- Persisted normalized observations without query strings, fragments, or raw URL paths.
- Added observation intake tests and extension TypeScript build dependencies.

## [2026-07-04] implementation | Privacy gate

- Added extension-side sensitive URL pre-drop before local server POST.
- Added server-side sensitive URL recheck before observation normalization.
- Logged dropped observations as `observation.dropped` with source, host, and reason only.
- Added success/failure smoke scenarios for allowed navigation storage and sensitive navigation drop behavior.

## [2026-07-04] implementation | CPU embedding and Tier 0

- Added `hash_cpu`, a deterministic local CPU-only embedding provider for reproducible Stage 0 tests.
- Stored declared-goal exemplar embeddings and computed Tier 0 `r0` for browser observations.
- Recorded Tier 0 verdicts and kept anchor state derived only from OK observation embeddings.

## [2026-07-04] implementation | API Tier 1

- Added an OpenAI-compatible Tier 1 judge provider and strict JSON parser.
- Added minimized Tier 1 payload construction with goal text, recent title/verdict pairs, current title, and URL host only.
- Escalated Tier 0 DRIFT observations to Tier 1 when a provider is configured, preserving local no-provider behavior for development.

## [2026-07-04] implementation | Controller and intervention handshake

- Persisted streak controller state in SQLite after each judged observation.
- Enforced coldstart, streak threshold, cooldown, and snooze gates.
- Returned `request_excerpt` only when the controller decides Kibitzer should prepare an intervention.

## [2026-07-05] implementation | Tier 2 confirmation and message

- Added `/observations/{observation_id}/excerpt` for the requested-excerpt handshake.
- Added minimized Tier 2 payload construction with current title, host, verdict, score, recent title/verdict pairs, and a bounded page excerpt.
- Added OpenAI-compatible Tier 2 support and Ollama Cloud `/api/chat` support.
- Wired default Tier 2 settings to the experiment model file without copying API keys into Kibitzer.
- Selected `ollama_cloud_gemma4_31b` after the earlier `qwen3.5:27b` entry returned 404 from the live Ollama Cloud endpoint.
- Added 30-case Tier 2 dataset smoke, provider config smoke, and real HTTP Tier 2 smoke.
- Verified Python tests, extension TypeScript build, LLM Wiki code snapshots, LLM Wiki search, and a real Ollama Cloud Tier 2 call.

## [2026-07-05] planning | Notification and feedback loop

- Next Work Package 9 should turn server-side `notify` results into Chrome notifications.
- Feedback actions should record `accepted`, add `related` observations as goal exemplars, and apply `snooze` to controller state.
- Tests should cover duplicate-safe feedback, exemplar cap enforcement, snooze gating, and extension notification button wiring.

## [2026-07-05] implementation | Notification and feedback loop

- Added `POST /feedback` with `related`, `accepted`, and `snooze` kinds.
- Made feedback duplicate-safe per intervention/kind.
- Made `related` add the observation embedding to session goal exemplars with cap enforcement.
- Made `snooze` update persisted controller state so later drift is logged without immediate intervention.
- Added notification message clamping through `delivery.max_sentences`.
- Wired the Chrome extension to show notifications and post feedback on notification button clicks.
- Added feedback unit tests and `scripts/smoke_feedback.py`.

# Handoff P0: Persona Engine, Voice, Quiet Hours

Date: 2026-07-06
Scope owner: delegated agent (Codex)
Parent plan: [roadmap-fun-layer.md](roadmap-fun-layer.md)

## Goal

Turn the fixed Tier 2 message prompt into a persona system with escalation
awareness, add spoken nags via macOS `say`, add quiet hours, and expose runtime
settings. Plumbing only — **all persona content and popup UI are owned by Claude**
and are out of scope here.

## Verified current state

- Tier 2 messages come from a hardcoded system prompt inside each judge provider:
  `apps/server/app/providers/judges/ollama_chat.py` (`confirm_tier2`) and the
  OpenAI-compatible twin. Output contract: strict JSON
  `{"confirm_drift":bool,"message":"<=2 short Korean sentences"}`.
- Fallback message when Tier 2 fails: `fallback_drift_message` in
  `apps/server/app/core/tier2_payload.py`.
- `configs/default.yaml` has `delivery.persona: "dry"` — currently read by nothing.
- `configs/personas.yaml` exists (authored by Claude — see schema below). Treat its
  content as read-only input; do not rewrite its prose.
- Intervention flow: `apps/server/app/api/observations.py::confirm_observation_excerpt`
  → `_confirm_tier2` → `store.create_intervention` → extension notification.
  Extension reports delivery via `POST /interventions/{id}/delivery`.
- The extension shows a pending-intervention card in the popup and a red badge for
  any intervention with status `pending`/`delivered`/`delivery_failed` (fallback
  when macOS suppresses notifications). Suppressed deliveries must keep this path.
- Tests: `.venv/bin/python -m pytest apps/server/tests -q` currently `55 passed`.

## personas.yaml schema (input contract)

```yaml
version: 1
default: dry_kibitzer
personas:
  <key>:
    name: "표시 이름"
    style_prompt: |            # style layer ONLY; JSON contract stays in code
      ...
    fallback_templates:        # used when Tier 2 provider fails
      - "문장 with {goal} {title} {host} {nag_count}"
    celebrate_templates: []    # reserved for P1, may be absent
    voice:                     # optional overrides
      voice: "Yuna"
      rate: 175
    max_sentences: 2           # optional, defaults to delivery.max_sentences
```

## Deliverables

### 1. Persona loading and prompt composition

- `apps/server/app/core/personas.py`:
  - `load_personas(path) -> PersonaSet` (pydantic models; unknown keys ignored).
  - `compose_tier2_system_prompt(persona) -> str` = code-owned base contract
    (the strict-JSON instruction currently in the providers, kept verbatim)
    + persona `style_prompt`. The JSON output contract must never come from YAML.
- Config: `delivery.personas_file: "configs/personas.yaml"`; `delivery.persona`
  becomes the default persona key (update default.yaml value to `dry_kibitzer`).
  Missing file or key → behave exactly as today (built-in prompt), and log one
  warning at startup.
- Providers: `confirm_tier2(payload, system_prompt: str | None = None)` — when
  None, keep the current built-in prompt. Update both providers and the
  `JudgeProvider` protocol; `classify_tier1` is untouched.

### 2. Escalation context

- New store queries (event-log/intervention based, all per session):
  - `nag_count_today(session_id) -> int` (interventions created since local midnight)
  - `last_intervention_ignored(session_id) -> bool` (latest intervention has status
    `pending`/`delivered`/`delivery_failed` — i.e. no feedback)
  - `minutes_since_last_ok(session_id) -> int | None`
- Inject into the Tier 2 payload as `payload["nagging_context"] = {"nag_count_today":…,
  "last_nag_ignored":…, "drift_minutes":…, "repeat_host":…}` where `repeat_host`
  is true when the current host equals the previous intervention's observation host.
  (The persona style prompts already instruct the model how to use these.)

### 3. Runtime settings

- SQLite `settings` table (`key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT`)
  + store `get_settings()` / `update_settings(partial: dict)`.
- API in a new `apps/server/app/api/settings.py`:
  - `GET /settings` → `{persona, voice_enabled, quiet_hours:{enabled,start,end}}`
    (defaults from config when unset).
  - `PUT /settings` with any subset; validates persona key exists, `HH:MM` times.
  - Events: `settings.updated` with the changed keys.
- Persona resolution order: settings.persona → config delivery.persona → personas.default.

### 4. Voice (macOS `say`)

- `apps/server/app/core/voice.py`: `speak(text, voice, rate)` using
  `asyncio.create_subprocess_exec("say", "-v", voice, "-r", str(rate), text)`,
  fire-and-forget, wrapped in try/except (missing binary → log once, never raise).
- Config defaults: `delivery.voice: {enabled: false, voice: "Yuna", rate: 175}`;
  `voice_enabled` runtime setting overrides. Persona `voice` block overrides
  voice/rate.
- Speak exactly when an intervention is created (server side), after quiet-hours
  check. Event: `delivery.voice_spoken` (message text NOT logged — only intervention_id).

### 5. Quiet hours

- Config default: `delivery.quiet_hours: {enabled: false, start: "09:00", end: "18:00"}`
  (local server time; range may cross midnight). Runtime settings override.
- When active at intervention-creation time: still create the intervention
  (pending card + badge keep working), but return `silent: true` in the
  `PipelineResult` (new optional field, default false) and skip voice. Record
  event `delivery.suppressed_quiet_hours {intervention_id}`.
- Extension `background.ts`: when `result.action === "notify" && result.silent`,
  skip `chrome.notifications.create` and the sound, still `postDeliveryReport(id, true)`
  (delivery = the badge path), still refresh the badge. This is the only extension
  file you may touch; do not touch `apps/extension/src/popup/**`.

## Constraints

- Do not edit `configs/personas.yaml` prose (schema-conformance fixes: flag, don't fix).
- Do not touch `apps/extension/src/popup/**` or any user-facing Korean copy.
- The strict-JSON Tier 2 output contract lives in code, never in YAML.
- All new failure paths degrade silently to today's behavior (no new 5xx).
- Keep `.venv/bin/python -m pytest apps/server/tests -q` green; add tests for:
  persona load + prompt composition, provider receives composed system prompt
  (fake provider capture), escalation payload fields, settings API roundtrip +
  validation, quiet-hours silent flag + suppression event, voice invocation
  (monkeypatched subprocess) and voice disabled by default.
- Extension: `npm run build` green; `dist/background.js` contains the silent-flag
  branch; no new permissions.

## Acceptance checks

```bash
.venv/bin/python -m pytest apps/server/tests -q          # all green, new tests included
cd apps/extension && npm run build                        # BUILD_OK
grep -c "silent" dist/background.js                       # >= 1
curl -s localhost:8765/settings                           # returns defaults (server restarted)
curl -s -X PUT localhost:8765/settings -d '{"persona":"quiet_coach"}' -H 'content-type: application/json'
```

Append a short entry to `docs/progress.md` when done. Claude will follow with the
popup persona/voice/quiet-hours UI and live-tune the persona prompts.

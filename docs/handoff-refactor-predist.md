# Handoff: Pre-Distribution Refactor & Bug Fixes

Date: 2026-07-15
Source: multi-agent audit on `feature/tray-status-menu` @ `c48b134` (31 agents —
2 mappers + 6 Opus bug-hunters + adversarial verification + 2 maintainability
agents). The historical report recorded 20 candidates → **17 confirmed**
(2 high / 6 medium / 9 low), 3 refuted. Reconciliation against
`origin/dev` @ `6ba1b36` leaves **14 actionable original findings**
(2 high / 5 medium / 7 low): C1, T4, and C4 were resolved by #36, #34, and #32.
Decision context: [planning-notes.md](planning-notes.md) D7 (packaging), D8
(app/extension split + same-repo refactor), D9 (this audit).
**Numbering note (2026-07-20):** planning-notes has since renumbered these
decisions — packaging is now **D9**, the app/extension split **D10**, and this
audit **D11**. This document keeps its original 2026-07-15 numbering.
Full original report (Korean, verbatim): **Appendix A** at the bottom.

> **Scope of this doc.** A work order that turns the audit into ordered,
> file-anchored tasks. It does **not** include the CWD-relative config/data path
> issue — that is D7 packaging phase-0, tracked separately.

> **Current reconciliation — this body supersedes Appendix A's implementation
> advice.** The audit snapshot was behind `dev`; code moved and three
> findings were resolved before this work order was written. Confirmed on
> 2026-07-15:
> - **C1 (r_final)** — fixed on `dev` by **#36** (`observations.py:215` sets
>   `r_final = tier1_final_relevance(...)`). Removed from the queue.
> - **C3 (hash_cpu non-ASCII)** — `dev` default embedding is now `onnx_cpu`
>   (384-dim transformer, **#29**); `hash_cpu` can still produce an invalid zero
>   vector, but the selected fix is a typed unsupported-input guard rather than
>   broadening fallback language support.
> - **M8 (CLI stub)** — still valid: `dev` `cli/main.py` is still
>   `SystemExit("not implemented")` even though the replay CLI (#14) shipped
>   elsewhere.
> - **T4 (provider failures invisible)** — resolved as originally framed by
>   **#34**: `/health.provider_calls` reports last failure/recovery and the popup
>   displays it. A consecutive-failure circuit breaker may be considered later,
>   but is not a confirmed release bug.
> - **C4 (history lost-update)** — fixed on `dev` by **#32**: history mutations
>   use a single promise queue, and `tests/history.test.mjs` covers concurrent
>   prepends/updates and queue recovery. Removed from the queue.
> - **M7 correction** — `embedding.model` and `embedding.batch_size` are live:
>   the ONNX factory passes both and `OnnxCpuEmbeddingProvider` consumes them.
>   They must not be removed.
> - **Counting correction** — Appendix A has 13 numbered maintainability
>   recommendations, not 15. This body additionally names the extension test
>   harness M13.
> - **Test-gap correction** — `test_tier1.py` already pins the
>   credentials-missing → one `provider.degraded` event path; Appendix A's claim
>   that this test is absent is stale.
> Re-confirm file anchors against the PR's `dev` base before implementation.

> **Product decisions confirmed by the user on 2026-07-15:** P1 uses the strict
> Host/exact-Origin boundary below; P2 disables incognito and also drops it
> defensively; C1 needs no further work; C2 rejects equal quiet-hours endpoints;
> C3 safely records but does not score unsupported embedding input; C6 keeps a
> compact title-centered history after debug detail expires; M6 deletes the dead
> feedback hooks without wiring new semantics; M10 uses the fixed candidate-port
> pool and discovery contract below. These are implementation requirements, not
> open product calls.

## How to read this

Each item has: **files**, **do**, **effort** (small ≈ <½ day, medium ≈ 1–2 days,
large ≈ 3+ days), **deps**, **tests**, **owner**. Owner follows the repo's
handoff convention: mechanical/plumbing → **Codex**; user-facing copy or a
product-semantics decision → **Claude/user** (discuss first). Each item is sized
to be one squash-merged PR into `dev` unless noted.

**Global gate:** `python -m pytest apps/server/tests -q` green + `apps/extension`
`npm run build` green before every PR (AGENTS.md rule 4). On current `dev`, the
build runs the real `node:test` extension suite plus `tsc`; expand that suite
with each extension change.

---

## Track 0 — Release gate (must land before ANY distribution)

These two can silently disable core behavior or make the app unusable. Both
must land before a distribution build. Keep R1 independent; R2 may be two
ordered PRs (server idempotency, then extension persistence), but the release
gate stays open until the end-to-end acceptance tests pass.

### R1 — Malformed provider config must degrade, not crash `[high]`
- **files:** `apps/server/app/providers/judges/factory.py`
  (`_resolve_experiment_model_settings`, `_provider_from_experiment_style`);
  `apps/server/app/core/runtime_resources.py`
  (`_ensure_tier1_provider`, `_ensure_tier2_provider`)
- **do:** Missing-credentials already returns `None` → Tier-0 degrade, but a
  malformed `models.local.yaml` **raises** — `ValueError` at `factory.py:212`
  (`api_style` not `openai`/`ollama` and URL lacks `/api/chat`), or
  `float()`/`int()` at `:181`/`:185` (non-numeric `timeout_sec` /
  `max_output_tokens`). The `_ensure_tier{1,2}_provider` calls run this
  **unguarded**, so a single typo in the hand-edited config makes the first
  goal-set return HTTP 400 and every subsequent browser-nav POST 500 → whole app
  unusable (reproduced end-to-end). Catch config/parsing exceptions inside each
  `_ensure_tier{1,2}_provider`, mark that tier initialized with provider `None`,
  and record exactly one `provider.degraded` event with
  `reason="config_invalid"`. Log the invalid field/type without logging keys or
  values that may contain secrets. Keep the other tier healthy if only one tier's
  config is invalid. **Strict policy:** do not silently coerce malformed numeric
  values to defaults; invalid `timeout_sec` / `max_output_tokens` degrades that
  tier just like an invalid `api_style`.
- **effort:** small · **deps:** none · **owner:** Codex
- **tests:** new — bad `api_style`, non-numeric `timeout_sec`, and non-numeric
  `max_output_tokens` each make only the affected tier `degraded`; goal-set and
  browser-nav still succeed through Tier 0; the healthy tier remains active; one
  `config_invalid` event is recorded per degraded tier even after repeated calls.

### R2 — MV3 dwell timers survive service-worker suspension `[high]`
- **files:** `apps/extension/src/background.ts` (observation + Tier-2 dwell);
  `apps/extension/src/lib/history.ts`; `apps/extension/src/lib/api.ts`;
  `apps/server/app/schemas.py`, `api/observations.py`, and `storage/sqlite.py`
  for idempotent retries; extension tests expanded by M13. The manifest already
  grants `alarms` and `storage`.
- **do:** Both dwells are bare `setTimeout`; a timer does not keep an MV3 worker
  alive, so suspension can discard it. Values above the usual ~30s idle window
  expose the bug systematically, although eviction timing is not deterministic.
  Make persistent state, not the in-memory timer, the source of truth:
  - store a versioned pending record in `chrome.storage.session` for each stage;
    observation records include a stable event/idempotency key, tab/token/url,
    start/history ID, due time, and Tier-2 dwell; Tier-2 records include a stable
    stage key, tab/url/candidate/observation ID, and due time;
  - schedule unique `chrome.alarms` names, restore/re-arm records on worker start,
    and validate the active tab, URL, token, and stage before continuing;
  - close the response-loss crash window: the browser-nav endpoint must accept
    the stable key and atomically store/replay its result, and excerpt retry must
    return the candidate's terminal result instead of creating/committing twice;
    do not rely on an in-memory “in flight” flag for exactly-once effects;
  - clear pending state only after the corresponding result is durably reflected
    in server/history state or the stage is deliberately cancelled;
  - short `setTimeout`s may remain as an optimization, but correctness must not
    depend on worker residency.
  A ≤25s client/server clamp is acceptable only as a dogfooding mitigation; it
  is **not** the distribution fix.
- **effort:** large · **deps:** M13 test-harness expansion · **owner:** Codex
- **tests:** with fake timers + a Chrome API mock — worker restart restores each
  stage; navigation/token change cancels stale work; duplicate alarm delivery is
  one committed observation/intervention; a server-success/client-response-loss
  retry replays the same result; successful completion clears alarm + state; 60s
  observation and Tier-2 dwells survive simulated suspension.

---

## Track 1 — Trust & privacy bundle (recommended before first public release)

Medium findings that damage judgment trust or the documented local-first,
data-minimizing boundary. The privacy sub-bundle (P-*) should be raised together
and must land before D8 exposes credentials/history through onboarding or a
dashboard. Cloud judge payloads are disclosed separately; “nothing leaves the
machine” is not the product promise.

### T1 — Version goals and reset all goal-scoped state on edit `[medium]`
- **files:** `apps/server/app/storage/sqlite.py` (`set_current_goal`, goals /
  observations schema, `recent_ok_embeddings`, intervention candidates,
  derived exemplars); `apps/server/app/api/sessions.py` (enrichment task);
  `apps/server/app/api/observations.py` (ingest + excerpt confirmation)
- **do:** `set_current_goal` rewrites the goal row and resets `goal_exemplars`
  to position-0, but leaves `controller_states` (streak/obs_count),
  `attachment_states`, and the anchor window intact. Result under a mid-session
  goal edit: old-goal pages stay OK-whitelisted via the anchor, coldstart is
  skipped (early nags), and a fake "return" celebration can fire. There is no
  current `goal_id`: `goals.session_id` is updated in place and observations only
  carry `session_id`. Add an integer `goal_revision` (or an equivalent immutable
  goal ID) and tag every observation/candidate/derived-enrichment write with the
  revision captured at ingest. On edit, atomically increment the revision, reset
  controller + attachment state, cancel old-revision intervention candidates,
  clear derived exemplars, and make late enrichment writes compare-and-swap on
  the expected revision. Anchor/recent queries must filter the current revision.
  After any embedding/provider await, re-check the captured revision before
  controller/candidate side effects; an old-revision observation may remain as
  historical data, but it must not mutate the new revision's live state.
- **effort:** large · **deps:** cheaper after M2 (ingest extraction) · **owner:** Codex
- **tests:** edit goal mid-session → anchor/controller/attachment reset and old
  pages no longer auto-OK; a late old-goal enrichment result is ignored; an old
  pending excerpt cannot create an intervention under the new goal; concurrent
  ingest retains the revision captured before its await. (Closes a §Tests gap.)

### T2 — Serialize the browser-nav read-modify-write around the Tier-1 await `[medium]`
- **files:** `apps/server/app/api/observations.py::ingest_browser_nav`
- **do:** `ingest_browser_nav` yields the loop at
  `await tier1_provider.classify_tier1(...)`; concurrent nav requests (rapid tab
  switches) reorder, so controller streak / `drift_started_at` latch update in
  completion order, not event order — a stale DRIFT overwrites a newer OK. Add a
  per-session `asyncio.Lock` around the read-modify-write, or compare observation
  timestamps and discard stale results before applying.
- **effort:** medium · **deps:** cheaper after M2 · **owner:** Codex
- **tests:** new — two interleaved observations with a slow Tier-1 → final state
  reflects event order. (Closes a §Tests gap.)

### T3 — Use a single-key pool as primary `[medium]`
- **files:** `apps/server/app/providers/judges/factory.py:179`
- **do:** The rotation pool is only consulted when ≥2 keys resolve; a single
  pooled key is discarded. So a user with only `ollama1` set silently loses
  Tier 2 (every drift becomes an unfiltered nag); only `ollama2` loses Tier 1.
  When `api_key` is empty and the pool has exactly one key, use `pool[0]` as
  primary. **This directly hits the 1-key onboarding path D7 is about to ship.**
- **effort:** small · **deps:** none · **owner:** Codex
- **tests:** new — 1-key `.env` in each slot → corresponding tier active.

### T5 — Distinguish HTTP validation errors from an offline server `[medium]`
- **files:** `apps/extension/src/lib/api.ts`; `apps/extension/src/popup/popup.ts`
- **do:** API wrappers collapse every non-2xx response to `null`, so a 422 from
  invalid settings is rendered as “server unreachable” and the rejected value
  appears to fail silently. Return a typed result that distinguishes network
  failure from HTTP status/error detail; render a validation message for 4xx;
  add matching client bounds (`cooldown <= 86400`, `k <= 20`) without treating
  client validation as a substitute for the server.
- **effort:** small · **deps:** none · **owner:** Codex (plumbing) + Claude (copy)
- **tests:** network failure → offline state; 422 → validation message with the
  server still online; successful update re-renders canonical server settings.

### P1 — Host-header allowlist + exact Origin boundary `[medium read / low write]`
- **files:** `apps/server/app/main.py`; a dedicated security middleware/config;
  all state-changing API routes (POST/PUT/PATCH/DELETE), including sessions,
  settings, feedback, labels, and future onboarding credentials
- **do:** `create_app()` mounts no `TrustedHostMiddleware` and no CORS. Two
  exploits confirmed cross-origin: (a) **DNS rebinding** reads goal + browsing
  report via read endpoints (external `Host` header → 200); (b) bodyless POSTs
  (`/sessions`, `/sessions/current/snooze`, `/end`) are CORS-simple requests, so
  any visited web page can **CSRF** snooze/end/reset the session (cross-origin
  200/201). Add `TrustedHostMiddleware` with hostname-only values
  `127.0.0.1` / `localhost` and `www_redirect=False` — Starlette strips the port
  before comparison, so entries containing `:8765` reject valid requests
  ([docs](https://www.starlette.io/middleware/)). For mutating requests, allow
  only exact configured origins: the production Web Store extension ID, an
  explicit dev-extension allowlist, and the same-origin dashboard/onboarding
  URLs constructed from the effective local port. Reject every other present
  Origin. Document absent-Origin as limited to loopback native/CLI clients; add
  a per-install token before credential/history APIs are exposed outside the
  same-origin UI. CORS headers alone are not the control.
- **effort:** small for Host/Origin boundary; token is a separate D8 prerequisite
  · **deps:** effective port implementation (M10) · **owner:** Codex
- **tests:** foreign Host rejected; `Host: 127.0.0.1:<port>` accepted; foreign
  webpage and unrelated extension origins rejected; exact production/dev
  extension origins and both supported same-origin UI hosts accepted; absent
  Origin behavior pinned; non-default effective port covered.

### P2 — Do not relay/persist incognito navigations `[low]`
- **files:** `apps/extension/src/background.ts` web-navigation/tab listeners;
  `apps/extension/manifest.json`
- **do:** Listeners relay incognito tab events undifferentiated; title + url_host
  are persisted to sqlite, violating the no-trace expectation. Set manifest
  `"incognito": "not_allowed"` **and** keep a defense-in-depth guard in every
  navigation/tab entry point: resolve the tab before history mutation or network
  relay and return immediately when `tab.incognito` is true. Unknown/missing tabs
  must fail closed for that event rather than relaying data that might be
  incognito. Do not add a memory-only incognito mode in this release.
- **effort:** small · **deps:** none · **owner:** Codex
- **tests:** incognito events never update extension history and never call the
  server; normal tabs still flow; tab lookup failure does not relay the event;
  manifest validation pins `incognito: not_allowed`.

### P3 — De-duplicate the privacy blocklist `[high payoff refactor, privacy-critical]`
- **files:** `apps/extension/src/lib/domainFilter.ts`;
  `apps/server/app/privacy/domain_filter.py`; `configs/sensitive_domains.yaml`
- **do:** The sensitive-host/keyword list **and its matching algorithm** are
  hand-duplicated on both sides. The extension is the first privacy gate, so a
  one-sided edit silently leaks sensitive URLs. Use the checked-in YAML as the
  source and generate the TS rules **at build time**; the extension privacy gate
  must work before the server is reachable, so runtime fetch-and-cache is not the
  primary design. Fail build/CI when generated output is stale and run shared
  fixtures through both matchers (exact/subdomain/path/keyword cases).
- **effort:** small · **deps:** best paired with M13 (test-harness expansion) for
  the parity test · **owner:** Codex

### P4 — Remove dead privacy toggles; keep minimization mandatory `[small, privacy-critical]`
- **files:** `apps/server/app/config.py`; `configs/default.yaml`;
  `apps/server/app/core/normalization.py`; `docs/privacy.md`
- **do:** `privacy.strip_query` and `privacy.hash_url_path` are parsed but never
  read. The implementation already avoids storing raw query/fragment and stores
  a SHA-256 of the path+query+fragment location. Make that an invariant: remove
  the ineffective toggles, retain the always-on normalization, and document
  exactly what is hashed. A future debug mode that weakens minimization requires
  a separate explicit design and must not arrive as a default config switch.
- **effort:** small · **deps:** none · **owner:** Codex

---

## Track 2 — Correctness cleanups (low; batch conveniently)

Not release-blocking. Group into 1–2 PRs.

| ID | files | do | effort | owner |
|---|---|---|---|---|
| C2 | `core/runtime_settings.py::quiet_hours_active`; settings schema/API; popup settings | quiet-hours `start==end` currently becomes 24/7 silent. Reject equality as invalid; do not interpret it as zero-width or all-day quiet | small | Codex + Claude (validation copy) |
| C3 | `providers/embeddings/hash_cpu.py`; embedding/ingest boundary | Keep current language scope. Replace an empty/zero/non-finite fallback vector with an explicit unsupported-input result; preserve the normalized observation with no verdict, but do not score or feed live state | small | Codex |
| C5 | `background.ts::playNotificationSound` | Memoize the `offscreen.createDocument` creation promise (single in-flight mutex) so concurrent notifications don't drop a chime | small | Codex |
| C6 | `storage/sqlite.py` (observations/events/report queries); settings + history API | Split full debug retention from compact long-term behavior history; paginate report judgments. Implement as C6a pagination then C6b compaction | medium each | Codex |

**C2 acceptance:** reject equal endpoints in both server validation and client
pre-validation with a clear message; preserve normal same-day and cross-midnight
ranges; show when quiet hours are currently active and the next end time.

**C3 acceptance:** do not add script-specific regex ranges or Unicode n-grams.
No supported tokens / a deterministic zero vector is a typed
`embedding_input_unsupported` outcome. Wrong dimensions or non-finite output is
instead `embedding_provider_invalid_output` and must also update provider-health
diagnostics; do not mislabel a provider fault as unsupported user text. Neither
path is caught with a broad `except Exception`. Store the title/host/timestamp
observation with `verdict=None` and no embedding; return `action=none`. Do not
call Tier 1, update controller/attachment state, admit an anchor, create a
candidate, or turn the invalid vector into DRIFT. Valid mixed-script input that
still yields supported tokens continues normally. Tests pin both failure classes
and prove controller/attachment state is unchanged.

**C6 retention contract:**

- **C6a — report pagination:** summary aggregates still cover the requested
  session/range, while the judgment list is cursor-paginated by stable `(ts,id)`
  order (`limit` default 100, maximum 500, `next_cursor` when more remain).
- **C6b — two-tier storage:** active sessions and ended sessions within a
  configurable debug window retain full replay detail; initial default is 7
  days after session end. A once-per-day/startup idempotent compactor converts
  older ended sessions to compact history.
- Compact history retains observation ID, session/goal relationship, timestamp,
  source, **title**, host, final verdict, and user-feedback relationship. It
  clears path hash, tab ID, embedding, intermediate scores, tier/reason detail,
  debug-only event payloads, and expired controller/candidate/vector state. Audit
  every duplicate event/table so deleted detail is not left elsewhere.
- Compact rows remain until explicit user deletion so later usage-habit analysis
  has longitudinal titles and outcomes. Privacy/onboarding docs must disclose
  title retention; P2 means incognito titles never enter either tier.
- Exact Replay CLI support is guaranteed only while full detail remains. It must
  reject a compacted session with a clear `debug detail expired` diagnostic,
  rather than silently presenting recomputed output as exact replay.
- Add a storage/API operation to delete all retained history (UI follows D8),
  protected by P1 and the per-install token once that token boundary lands.
- Tests cover compaction cutoff/active-session exclusion/idempotency, absence of
  vectors and debug reasons across all tables after compaction, compact report
  correctness, cursor stability, and complete history deletion.

---

## Track 3 — Maintainability and packaging feeders

Ordered so that dependency-unlocking refactors come first. Most are not
release-blocking, but M8/M10 feed packaging and M2/M13 are pulled forward by the
dependency graph. The two starred items are the biggest maintenance unlockers.

| ID | item | files | effort | notes / deps |
|---|---|---|---|---|
| **M2** ★ | Extract ingest pipeline | `api/observations.py::ingest_browser_nav` → new `core/ingest.py`; delete dead `core/pipeline.py` | medium | **Do early** — unlocks cheaper T1, T2, and controller tests |
| M3 | De-dup controller math | `observations.py::_drift_confirmed_after_observation` / `_next_alignment_score` reuse `AlignmentController`/`StreakController` instead of reimplementing EMA/streak | medium | after M2 |
| M4 | Wire-type codegen | `lib/api.ts` hand-written response interfaces ← `/openapi.json` via `openapi-typescript` in build/CI; consolidate server inline response models into `schemas.py` | medium | catches server field renames at `tsc` |
| M5 | Split `storage/sqlite.py` (~2,550 lines at this baseline) | pull the 4 report aggregation helpers (`_report_from_rows`, `_hourly_related_ratio`, `_top_drift_hosts`, `_longest_ok_stretch`) → `storage/reporting.py`; pass the report clock explicitly where needed; gate `_ensure_schema` once instead of per operation; decide `:memory:` support explicitly | large | absorbs the sync-connect/schema-bootstrap low bug |
| M6 | Delete dead code | `core/anchor.py`, `logging/event_log.py`, `relevance.tier0_verdict`, `domain_filter.host_from_url`, controllers' unused `on_feedback` | small | Remove `on_feedback` from the controller protocol/implementations; do **not** wire `related` feedback into controller state. Keep the existing exemplar feedback flow unchanged |
| M7 | Remove genuinely unread config | `delivery.channel`, `Tier1SendConfig.url_path`/`page_excerpt` | small | **Do not remove** `embedding.model` or `batch_size`: both feed the ONNX provider. P4 owns the privacy flags separately |
| M8 | Fix the CLI entry point | `pyproject.toml` `kibitzer` → `SystemExit('not implemented')` stub; implement a minimal "start server" launcher (needed for the single-binary anyway) or remove the entry | small | feeds D7 packaging |
| M9 | Hoist duplicated prompts | Tier-2 system prompt ×3 (already diverged), Tier-1 ×2, Korean fallback drift copy ×2 → shared prompts module | small | copy-touching → Claude reviews |
| M10 | Candidate-port discovery | replace half-wired `KIBITZER_PORT`/hardcoded 8765 with the confirmed five-port runtime contract below; align launchers, extension, live setup docs, and packaging | medium | feeds D7 and P1; docs → Claude |
| M11 | Split `background.ts` | badge renderer → `lib/badge.ts`; toast state machine → `lib/notifications.ts` (unit-testable). Defer the large `popup.ts` split to post-packaging | medium | post-R2 cleanup; not a prerequisite for the persistent fix |
| M12 | Misc | unify settings validation via `ControllerConfig.model_validate`; centralize the legacy `'window'`→`'alignment'` compatibility boundary and define its removal; fix `build_tier1_payload` `Goal` annotation → `GoalRecord` | small | — |
| **M13** ★ | Expand the extension unit-test harness | existing `node:test` suite under `tests/`; reusable Chrome tabs/alarms/storage doubles + fake timers | small | #32 already covers the history queue; test `shouldDropUrl`, and extract/export `normalizeSettings` as a pure helper before testing it; then add P3 parity + R2 restart/idempotence tests. Do not introduce Vitest unless `node:test` proves insufficient |

**M6 acceptance:** verify each symbol has no live/import-by-string call site, then
delete it. Specifically remove `on_feedback` from the base protocol and both
controllers, including the dead `'relevant'` comparison. Do not add a replacement
call in `feedback.py`; `related` continues to teach future judgments through the
existing exemplar path, and intervention confirmation remains the controller
reset boundary.

**M10 effective-port contract:**

- Use the ordered pool `49187, 51387, 53587, 55787, 57987`. These are local
  Dynamic/Private candidates, not collision-free reservations. Remove the
  arbitrary runtime `KIBITZER_PORT` override from the supported product path;
  one half-wired override is worse than a discoverable contract.
- Keep the list in one checked-in machine-readable source (for example
  `configs/port-candidates.json`). Package it with the server and generate the
  extension constant at build time; CI fails if generated output is stale.
- At launcher startup, first detect an already-running Kibitzer by a versioned
  read-only identity response (`service=kibitzer`, protocol version, instance
  ID). Otherwise atomically bind the first available candidate — the successful
  bind itself selects the port; do not check-then-close-then-bind. If all five
  are unavailable, fail visibly with the attempted ports and owning-process
  diagnostics where the OS permits. Do not silently choose an undiscoverable
  random port.
- The extension caches the last successful port in `chrome.storage.local`, probes
  it first, then probes the ordered pool with short timeouts and validates the
  identity response before any mutation. Discovery requests are GET-only. An
  identity marker is service discovery, not authentication.
- Change extension host permission to `http://127.0.0.1/*`; use
  `127.0.0.1` consistently for product traffic. P1 builds same-origin UI origins
  from the selected effective port; the extension Origin remains
  `chrome-extension://<id>` and is independent of the server port.
- Align macOS/Windows launchers, health/status checks, onboarding/dashboard
  links, and current setup docs. Preserve historical logs as history. Also make
  both setup scripts use `npm ci` and document one supported Python-version
  policy while retaining intentional platform-specific interpreter discovery.
- Tests cover first/second candidate collision, all candidates occupied, existing
  Kibitzer detection, unrelated-service rejection, cached-port recovery,
  non-default same-origin P1 acceptance, and server/extension list parity.

★ = highest post-launch payoff.

---

## Track 4 — Test coverage (write alongside M2/M3, cheaper after)

**Server** (`apps/server/tests`):
- `StreakController` direct unit tests (coldstart gate, k threshold, cooldown,
  snooze) — currently only covered indirectly via the HTTP handshake.
- `apply_controller` (streak/alignment dispatch + state persistence).
- alignment branch of celebration detection (`_next_alignment_score`);
  attachment tests only exercise streak mode today.
- Gaps that confirmed bugs exposed: concurrency (T2), goal-change reset (T1),
  and invalid/unsupported embedding output (C3).

**Extension — M13** (`apps/extension`): #32 added a real `node:test` suite,
wired it into `npm test` and `npm run build`, and covered history validation,
serialization, and storage failures. `shouldDropUrl` (privacy gate) and
`normalizeSettings` (hand-copied server Pydantic ranges + theta order) remain
pure but untested. Extend the existing runner with reusable Chrome API doubles
and fake timers; that seam also carries P3 blocklist parity, R2 restart/
idempotence, and M4 wire-type validation.

---

## Suggested sequencing (dependency graph)

```
Release gate:      R1              M13 expansion ──▶ R2a idempotency ──▶ R2b persistence

Trust bundle:      T3, T5, P2, P3, P4  (parallel where independent)
                   M10 port implementation ──▶ P1
                   T1, T2  ── depend on ──▶ M2 (do M2 first if bundling)
                                             │
Maintainability:   M2 ★ ──▶ M3 ──▶ Track-4 controller tests
                   M13 (node:test doubles) ──▶ P3 parity test, M4 validation
                   M5 ──▶ C6a pagination ──▶ C6b compaction
                   M6, M7/P4, M8, M9, M10, M11, M12  (independent)
Packaging (D7-0):  code prep runs in parallel; M8 + M10 feed it; no release build before R1/R2
```

Practical first PRs, in order:
1. **R1** (factory degrade) — smallest, safest, closes a test gap.
2. **M13** (expand `node:test` with Chrome test doubles), then **R2a** server
   idempotency and
   **R2b** persistent/alarm state. The gate closes only after the combined tests.
3. **T3** and **T5** as separate small fixes; implement **M10**'s confirmed
   effective-port contract, then land **P1** against that contract.
4. **M2** (ingest extraction) — the keystone; makes T1/T2 and controller tests
   cheap. Then T1, T2.
5. **P3** generated blocklist + parity fixtures; P2/P4 can land alongside the
   privacy bundle in separate reviewable PRs.
6. **M5**, then **C6a/C6b**, so report extraction lands before pagination and
   storage compaction touch the same SQLite/report seams.

Everything lands as small `fix/*` / `chore/*` / `refactor/*` PRs into `dev`
(AGENTS.md workflow). Branch from `dev`, not from any feature branch.

---

## Appendix A — Original audit report (verbatim, Korean)

> Generated 2026-07-15 by the pre-distribution audit workflow (task
> `wrr2kimts`). Preserved verbatim as the historical record of the audit snapshot,
> **not** as current implementation guidance. Use the corrected work-order body
> above. Errata/reconciliation:
> - the audit ran on `c48b134`, behind the `dev` base used for this document;
> - C1, T4, and C4 were subsequently resolved by #36, #34, and #32, leaving 14
>   actionable original findings (2 high / 5 medium / 7 low) on `origin/dev` @
>   `6ba1b36`;
> - the report contains 13 numbered maintainability recommendations, not 15;
> - recommendation 7 incorrectly labels live `embedding.model` / `batch_size`
>   fields as unread; M7 above corrects it;
> - current `dev` has a real extension `node:test` runner from #32, and already
>   has the credentials-missing degradation test; the old test-gap section is
>   preserved only as snapshot evidence;
> - R1 numeric fallback, T1 nonexistent `goal_id`, and P1 host-with-port / local
>   UI Origin instructions are corrected in the body above.
> Original refutations: voice task GC, `renderReport` unguarded, and
> OS-notification feedback loss.

# Kibitzer 배포 전 감사 최종 보고서

대상: `/Users/eunu03/kibitzer` (FastAPI 서버 + Chrome MV3 확장) · 기준일 2026-07-15
후보 발견 20건 중 적대적 검증을 통과한 17건을 확정, 3건 기각. 알려진 이슈(CWD-상대 config/data 경로)는 packaging phase-0으로 이미 계획되어 있어 본 보고서에서 제외.

---

## ① 배포 차단급 버그 (high)

### 1. malformed `models.local.yaml`이 degrade 대신 hot path를 크래시시킴
- **위치**: `apps/server/app/providers/judges/factory.py:212` (그리고 `:181`, `:185`)
- **요약**: credentials 누락은 `None`을 반환해 Tier 0으로 degrade하지만, config 형식 오류는 `ValueError`를 raise한다 — `api_style`이 "openai"/"ollama"가 아니고 URL에 `/api/chat`이 없으면 `:212`에서, `timeout_sec`/`max_output_tokens`가 비숫자면 `:181`/`:185`의 `float()`/`int()`에서. 이 factory 호출은 `runtime_resources.py:138/148`의 `_ensure_tier{1,2}_provider`가 **unguarded**로 실행한다.
- **실패 시나리오**: 사용자가 OpenAI-호환 endpoint를 쓰면서 `api_style: "openai"`를 빼먹거나 `max_output_tokens: "640 tokens"`처럼 적으면 — `configs/experiment-models.example.yaml`이 직접 편집을 안내하는 파일이다 — 첫 goal 설정이 HTTP 400("unsupported experiment Tier 2 api_style")으로 실패해 **앱 전체가 사용 불가**. goal이 이미 저장된 상태에서 config가 깨지면 모든 browser-nav POST가 500. 실제 앱에서 end-to-end 재현 완료.
- **권장 수정**: `_ensure_tier{1,2}_provider`에서 factory 호출을 `try/except Exception`으로 감싸 provider를 `None`으로 두고 `record_provider_degraded(reason="config_invalid")`를 기록. 같은 파일의 `_describe_tier`(runtime_resources.py:87-90)는 이미 동일한 raise를 catch하고 있으므로 이 패턴을 hot path에도 적용하면 된다. 추가로 factory 내부에서 numeric cast 실패 시 기본값 fallback + 경고 로그를 권장.

### 2. MV3 service worker 수명(~30s)을 넘는 dwell 타이머가 `setTimeout`으로 구현됨
- **위치**: `apps/extension/src/background.ts:126` (observation dwell), `:240/:253-257` (Tier 2 dwell)
- **요약**: 두 dwell 모두 bare `setTimeout`이며, MV3 worker는 idle ~30초에 종료되면서 타이머를 버린다. `chrome.alarms` 재예약이나 상태 영속화가 전혀 없다. 설정 UI는 두 dwell을 최대 300초까지 허용(`popup.ts:856-863`, `api.ts:286-287`, 서버도 동일 범위 허용)하므로 30초 초과 값에서는 **확정적으로** 유실된다.
- **실패 시나리오**: `tier2_seconds=60` 설정 후 drift 발생 → `request_excerpt` 수신 → `delay(≈55000ms)` 대기 중 worker eviction → excerpt 추출/Tier 2 개입이 영원히 발생하지 않음. `observation_seconds > 30`이면 `postBrowserNav` 자체가 유실. 사용자는 추적이 살아있다고 믿지만 관측이 조용히 삼켜진다 — 허용 설정 범위의 약 90%에서 핵심 기능이 무음 실패.
- **권장 수정**: pending dwell 상태(tab_id, url, 만료 시각)를 `chrome.storage.session`에 영속화하고, ~25초를 넘는 dwell은 `chrome.alarms`(최소 30초 단위)로 예약 + worker 재기동 시 복원. 근본 수정 전 최소한의 응급조치로는 클라이언트/서버 양쪽에서 dwell 상한을 25초로 clamp.

---

## ② 그 외 확인된 버그 (medium / low)

| 위치 | 심각도 | 요약 | 권장 수정 |
|---|---|---|---|
| `storage/sqlite.py:764` | medium | 세션 중 goal 수정 시 이전 goal의 anchor·`controller_states`·`attachment_states`가 새 goal로 그대로 이월 — 옛 goal 페이지가 새 goal에서도 OK 판정(anchor whitelist), coldstart 생략으로 조기 개입, 가짜 "복귀" 축하 | `set_current_goal`에서 controller/attachment 상태 리셋 + `recent_ok_embeddings`를 goal 버전(goal_id)으로 필터링 |
| `api/observations.py:220` | medium | Tier 1 `await` 지점에서 동시 nav 요청이 재정렬되어 controller streak / `drift_started_at` latch가 이벤트 순서가 아닌 완료 순서로 갱신됨 (stale DRIFT가 최신 OK를 덮어씀) | 세션 단위 `asyncio.Lock`으로 read-modify-write 구간 직렬화, 또는 적용 전 관측 timestamp 비교로 stale 결과 폐기 |
| `providers/judges/factory.py:179` | medium | rotation pool은 키 2개 이상일 때만 사용되고 단일 pool 키는 버려짐 — `.env`에 `ollama1`만 설정한 1-key 사용자는 Tier 2가 조용히 비활성화(모든 drift가 무필터 nag로 확정), `ollama2`만 설정하면 Tier 1 비활성화 | `api_key`가 비었고 pool에 키가 1개면 `pool[0]`을 primary로 사용 |
| `core/runtime_resources.py:153` | medium | 생성됐지만 100% 실패하는 provider(만료 키, 도달 불가 endpoint)는 `provider.degraded` 이벤트가 없고 `/health`가 계속 "active" 보고 — LLM 스택 전면 다운을 사용자가 알 수 없음 | `tier{1,2}.provider_error` 연속 실패 카운트를 health에 반영(간단한 circuit-breaker), 임계 초과 시 degraded 이벤트 기록 |
| `popup/popup.ts:973` (+ `lib/api.ts:322`) | medium | 모든 non-2xx를 `null`로 접어 "서버 연결 안 됨"으로 오진 — 특히 422(cooldown>86400, k>20)에서 설정이 조용히 미적용되고 오프라인 배너 표시 | `api.ts`에서 네트워크 실패와 HTTP 오류 구분(상태코드 반환), 422는 검증 메시지 표시; `#cooldown-seconds`에 `max` 속성 및 k 상한 검사 추가 |
| `main.py:49` + `api/sessions.py:273/303/151` | medium(읽기)/low(쓰기) | **병합 항목**: Host/Origin 검증 미들웨어 전무 → (a) DNS rebinding으로 goal·방문 기록 report 원격 읽기 가능(외부 Host 헤더로 200 확인), (b) bodyless POST(`/snooze`, `/end`, `/sessions`)는 preflight 없는 simple request라 임의 웹페이지가 CSRF로 세션 snooze/종료 가능(교차 출처 200/201 확인) | `TrustedHostMiddleware`로 `127.0.0.1:8765`/`localhost:8765` allowlist + 상태 변경 POST에 Origin 검사(`chrome-extension://` 및 Origin 부재만 허용) |
| `api/observations.py:201` | low | Tier 1이 DRIFT→OK로 뒤집어도 `r_final`이 Tier 0 값으로 고정 → alignment controller EWMA가 rescued OK를 drift처럼 반영, latch 오염 | Tier 1 override 시 `r_final`도 보정(예: `max(r0, tau_ok)`) |
| `core/runtime_settings.py:120` | low | quiet hours `start == end`가 무조건 True → 모든 알림·축하가 24/7 무음, 원인 표시 없음 | PUT 검증에서 start==end 거부(또는 zero-width 해석), popup에 quiet-hours 활성 상태 표시 |
| `storage/sqlite.py:1625` | low | 모든 store 호출마다 새 sync sqlite3 연결 + `_ensure_schema` executescript 재실행이 event loop를 블록 (browser-nav 1건당 8-10회) | schema bootstrap을 `initialize()` 1회 + 인스턴스 플래그로 gate (③-5 storage 분리와 함께 처리) |
| `storage/sqlite.py:804` | low | 관측마다 256-dim embedding을 영구 저장(보존 정책 없음), report는 세션 전체 관측을 무제한 직렬화 | anchor window 이탈 후 `emb` 제거 또는 별도 테이블+pruning; report judgments에 LIMIT |
| `providers/embeddings/hash_cpu.py:9` | low | `TOKEN_RE`가 ASCII/한글만 매칭 → 중국어/일본어/키릴/아랍어/이모지 제목은 zero vector → 무조건 DRIFT (Tier 1 escalation 낭비, degrade 시 오탐 nag) | 토큰 0개일 때 문자 n-gram fallback, 또는 TOKEN_RE에 CJK/가나/키릴 범위 추가 |
| `lib/history.ts:26` | low | `chrome.storage.session` get→mutate→set 무잠금 → 탭 병행 시 탐색 기록 항목/판정 lost-update (표시 전용 데이터, 영향 경미) | 단일 promise queue로 쓰기 직렬화 |
| `background.ts:471` | low | 동시 알림 2건이 둘 다 `getContexts()==0`을 보고 `offscreen.createDocument` 경합 → 한쪽 chime 유실 | 생성 promise를 memoize(단일 in-flight promise mutex) |
| `background.ts:638` | low | incognito 탭 이벤트를 구분 없이 서버로 중계, title+url_host가 sqlite에 영구 저장 — incognito 무저장 기대 위반 | 리스너에서 `tab.incognito` 스킵, 또는 manifest에 `"incognito": "not_allowed"` |

(모든 항목 verifier confidence: high — 저신뢰 플래그 대상 없음)

---

## ③ 유지보수성 리팩터링 추천 (payoff 순)

**Payoff: high**

1. **Privacy blocklist 이원화 해소** — `apps/extension/src/lib/domainFilter.ts` vs `configs/sensitive_domains.yaml`+`app/privacy/domain_filter.py`. 목록과 매칭 알고리즘이 양쪽에 손으로 중복되어 있어 한쪽만 수정하면 민감 URL이 조용히 전송된다(확장이 1차 privacy gate). 빌드 타임에 YAML→TS 배열 생성 또는 서버가 rules를 노출하고 확장이 fetch-and-cache. 최소한 parity 테스트로 CI에서 drift 차단. *(effort: small)*
2. **Ingest pipeline 추출** — `api/observations.py:139-239`의 ~100줄 `ingest_browser_nav`가 제품의 핵심 로직인데 HTTP 레이어를 통해서만 테스트 가능. `core/ingest.py`로 추출하고 dead legacy인 `core/pipeline.py` 삭제. ①-1, ②의 동시성 수정도 이 추출 후가 훨씬 쉽다. *(effort: medium)*
3. **Controller 로직 중복 제거** — `observations.py:355-382`의 `_drift_confirmed_after_observation`/`_next_alignment_score`가 `AlignmentController`/`StreakController`의 EMA·streak 공식을 재구현. controller가 `confirmed_drift` 결과를 노출하게 하고 재계산 제거. *(effort: medium)*
4. **Wire type codegen** — `lib/api.ts`의 ~25개 수제 인터페이스 vs 서버 Pydantic 모델이 무연결. `/openapi.json` → `openapi-typescript`를 빌드/CI 단계로 추가하면 서버 필드 rename이 `tsc`에서 잡힌다. 서버 쪽 inline response 모델도 `schemas.py`로 통합. *(effort: medium)*
5. **`storage/sqlite.py` (1,829줄) 분해** — aggregate별 분리, 최소한 순수 report 집계 4개(`_report_from_rows` 등, :1478-1608)를 `storage/reporting.py`로. schema bootstrap을 per-query에서 1회로 gate(②의 low 버그 해결과 동일 작업). `:memory:` 지원 여부도 명시적으로 결정(현재 per-op fresh connection이라 사실상 비작동). *(effort: large)*

**Payoff: medium**

6. **Dead code 삭제** — `core/anchor.py`, `logging/event_log.py`, `relevance.tier0_verdict`, `domain_filter.host_from_url`, 그리고 세 controller의 `on_feedback` (호출처 없음 + `'relevant'` vs 실제 enum `'related'` 문자열 불일치라는 잠재 버그를 가림). 'related' 피드백 시 streak 리셋이 실제로 원한 동작이면 feedback.py에서 올바른 enum으로 명시적으로 연결. *(small)*
7. **읽히지 않는 config 제거 / privacy 플래그 배선** — `embedding.model`·`batch_size`, `delivery.channel`, `Tier1SendConfig.url_path`·`page_excerpt`, 그리고 특히 `privacy.strip_query`·`hash_url_path`는 아무것도 제어하지 않는데 default.yaml에 true로 문서화되어 있어 **배포 전 config가 privacy 동작을 과장하지 않도록 반드시 정리**. *(small)*
8. **깨진 CLI entry point** — pyproject.toml이 `kibitzer` 명령을 `SystemExit('not implemented')` stub에 연결. 최소한의 'start server' launcher를 구현(single-binary 배포에 어차피 필요)하거나 entry 제거. *(small)*
9. **프롬프트/fallback 상수 중복** — Tier 2 system prompt 3벌(이미 문구 divergence 발생), Tier 1 prompt 2벌, 한국어 fallback drift 문구 2벌. 공용 prompts 모듈로 hoist. *(small)*
10. **`KIBITZER_PORT` 반쪽 배선** — macOS 스크립트/메뉴바만 인식, Windows 스크립트와 확장(`SERVER_BASE_URL` 하드코딩)은 무시 → macOS에서 설정 시 무음 단절. end-to-end로 배선하거나 override 제거해 8765 단일 상수로 확정 + 양 setup 문서에 반영. macos_setup의 `npm install`→`npm ci`, Python 버전 선호(3.12 vs 3.11) 정렬. *(small)*
11. **`background.ts` (663줄) 분해** — badge 렌더러(~100줄)와 toast 상태머신(~180줄)을 `lib/badge.ts`/`lib/notifications.ts`로 추출해 단위 테스트 가능하게. popup.ts(979줄) 분리는 packaging 이후로 유예. *(medium)*

**Payoff: low**

12. settings 검증을 `ControllerConfig.model_validate`로 일원화, 'window'→'alignment' alias 3곳→1곳, `build_tier1_payload`의 `Goal` annotation을 실제 전달 타입(`GoalRecord`)으로 수정. *(small)*
13. setup 문서는 현재 정확하나 gate 없음 — port 스토리 확정 후 양 가이드 갱신, 장기적으로 스크립트 self-describing에 의존해 prose 축소. *(small)*

---

## ④ 테스트 커버리지 공백

**서버** (`apps/server/tests`):
- `StreakController` 직접 단위 테스트 없음 (coldstart gate, k 임계, cooldown, snooze) — HTTP handshake 경유로만 간접 커버.
- `apply_controller` (streak/alignment dispatch + 상태 영속화) 직접 테스트 없음.
- `RuntimeResources` credentials-missing → provider None → 단일 `provider.degraded` 이벤트 경로 테스트 없음.
- 축하 감지의 alignment 분기(`_next_alignment_score`) 미테스트 (attachment 테스트는 streak 모드만 사용).
- **확정 버그가 드러낸 공백**: 동시 요청 테스트 전무(②-2), goal 변경 시 상태 리셋을 pin하는 테스트 전무(②-1), 비한글/비ASCII 임베딩 케이스 전무(②의 hash_cpu 건).

**확장** (`apps/extension`): 테스트 러너 자체가 없음 — `npm test`는 `tsc --noEmit`, CI는 빌드만. `shouldDropUrl`(privacy gate), `normalizeSettings`(서버 Pydantic 범위 수제 복제 + theta 순서), history dedup/cap 모두 chrome.* 의존 없는 순수 함수라 하네스 문제가 아닌 순수 누락. vitest 도입 후 이 3개 모듈부터 시작 — blocklist parity 테스트(③-1)와 wire-type 검증의 기반이 된다.

우선순위: ③-2(pipeline 추출)와 ③-3(controller 통합) 이후에 작성하면 비용이 크게 줄어든다.

---

## ⑤ 종합 판정

후보 발견 20건을 적대적 검증에 걸어 17건 확정·3건 기각(voice task GC, renderReport 미가드, OS-notification 피드백 유실 — 모두 주장된 실패 메커니즘이 실제로는 불가능)했으며, 확정 건은 전부 confidence high로 코드 경로 추적 또는 실행 재현까지 완료된 상태다. 배포를 차단하는 것은 high 2건 — config 오타 하나로 앱 전체가 죽는 factory `ValueError`와, 설정 범위의 대부분에서 핵심 관측이 무음 유실되는 MV3 dwell 타이머 — 이며 둘 다 국소적 수정(unguarded 호출 try/except + degrade, `chrome.alarms` 전환 또는 dwell 상한 clamp)으로 해결 가능하다. medium 6건 중 goal-수정 상태 이월과 provider health 오보고는 제품의 판정 신뢰성에 직결되므로 첫 공개 릴리스 전에 함께 처리할 것을 권장하고, privacy 항목(Host/Origin 검증, incognito, blocklist 이원화, 죽은 privacy 플래그)은 "데이터는 로컬에 머문다"는 제품 약속과 직접 충돌하므로 낱개 심각도보다 묶음으로 우선순위를 높일 가치가 있다. 그 외 low 9건과 리팩터링 항목은 배포를 막지 않으나, 확장 테스트 하네스 부재와 pipeline god-function은 배포 후 유지보수 비용의 최대 원천이 될 것이므로 packaging phase-0 직후 착수를 권장한다.

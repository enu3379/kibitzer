# Progress

## 2026-07-08 Audit Step 0: Labeled Replay Corpus (Claude)

Completed:

- Labeled all 231 observations across the Mac DB's four real sessions
  (LG그램 수리 33, 마인크래프트 23, 크리에이트모드 159+16) with page-fact
  labels (`related`/`drift`) + `title_quality`, via a multi-agent workflow:
  two independent labelers per chunk (verdicts hidden to avoid bias), an
  adjudicator for disagreements — 226/231 inter-labeler agreement, 5
  adjudicated, 0 human escalations.
- Joined labels with deterministic replay scores (current code, default
  config) and published the corpus + analysis to `docs/audit/step0/`
  (labeled CSVs, confusion matrices, r0 histograms, τ/audit-band trade-off
  curves, Tier-1 call-rate-over-time, full false-OK/false-DRIFT lists).
- Key findings: Tier-0 false-DRIFT dominates (80/142 related pages under τ,
  56%) driven by the cross-lingual Korean-goal ↔ English-title gap and
  sub-topic vocabulary (related-r0 mass at 0.00); false-OK is 9/89 from
  lexical collisions ("그램"⊂"킬로그램") and anchor proximity; no τ value
  fixes both sides → D3 goal enrichment (with mandatory cross-lingual
  phrases) promoted to the top of the trust-spine backlog;
  `audit_ok_below` 0.30–0.35 supported by the false-OK distribution;
  Tier-1 would-call rate does not decline within sessions (58–100%) —
  baseline recorded for the audit plan's health metric.

Verified:

- Workflow: 17 agents, 0 errors; labels cover 231/231 rows exactly once.
- Analysis reproducible from `docs/audit/step0/README.md` regenerate note.

## 2026-07-08 P1 Attachment Loop Plumbing

Completed:

- Implemented P1 attachment-loop server plumbing:
  - return celebrations after confirmed drift -> real OK return, with
    `celebration.min_drift_minutes`, `celebration.cooldown_seconds`, quiet-hours
    suppression, random persona `celebrate_templates`, and no immediate repeat;
  - `break` feedback kind for "5분만", using `break.duration_seconds` and
    marking interventions as `break`;
  - custom persona merge from `configs/personas.yaml` plus
    `~/.kibitzer/personas.yaml`, with invalid custom entries skipped;
  - `GET /personas`;
  - `GET /sessions/current/report` and `GET /reports/daily?date=YYYY-MM-DD`;
  - persisted `observations.tier1_reason`, exposed in pending interventions and
    report judgments.
- Extended the extension plumbing:
  - `PipelineResult.kind` supports `intervention` vs `celebration`;
  - celebration toasts render without feedback buttons and do not create
    intervention rows;
  - intervention toasts route `related` / `break` / `snooze`;
  - legacy system notification fallback uses `related` / `break` within Chrome's
    2-button limit.
- Added [P1 Claude Design/Copy Follow-Up](handoff-p1-claude-design.md) for
  celebration styling, break button copy/layout, persona selector UI, report UI,
  and "왜?" transparency affordances.

Verified:

- `.venv/bin/python -m pytest apps/server/tests -q` -> `90 passed`.
- `npm --prefix apps/extension run build` -> passed.

Current boundary:

- Server contracts and extension mechanics for P1 are in place.
- Popup report/persona/transparency UI and final Korean copy/style remain
  Claude-owned follow-up work.

## 2026-07-07 Daily Wrap

Completed:

- Rebased the working Mac folder onto the GitHub-backed repository and preserved
  local runtime artifacts (`.venv`, `data`, extension `node_modules`/`dist`, and
  local `.llm-wiki/` state).
- Archived legacy local/Windows transfer folders outside the active checkout so
  the GitHub-backed folder is now the canonical working tree.
- Integrated the alignment/dwell controller handoff:
  - B안 remains the configurable consecutive-drift controller;
  - A안 is now the original cumulative alignment + hysteresis controller;
  - settings/API/popup paths expose the relevant controller knobs.
- Added dwell-gated browser judging:
  - Tier 0/Tier 1 navigation judging starts only after the active tab stays on
    the same URL for 5 seconds.
  - Tier 2 excerpt extraction/submission waits until 10 seconds total on the
    same URL.
  - The extension rechecks tab activity and URL before extraction, submission,
    and notification display.
- Added the idle daemon design and macOS implementation:
  - single server process with `idle` and `active` modes;
  - lazy provider initialization on goal-backed tracking;
  - return to `idle` on session end;
  - `GET /health` mode reporting;
  - macOS LaunchAgent install/uninstall scripts.
- Created [Idle Daemon Plan](idle-daemon-plan.md),
  [Windows Idle Tray Plan](windows-idle-tray-plan.md), and
  [2026-07-07 Alignment/Dwell Handoff](handoff-2026-07-07-alignment-dwell.md).
- Opened PR #1 for the macOS idle daemon work, marked it ready, and merged it to
  `main` as merge commit `0317467`.

Verified:

- `bash scripts/macos_setup.sh` completed on the Mac checkout.
- `.venv/bin/python -m pytest` passed before and after the idle daemon work
  (`68 passed` on the final server test run after the alignment controller
  landed).
- `npm --prefix apps/extension run build` passed after the dwell-gate and idle
  daemon changes.
- `bash -n scripts/macos_install_launch_agent.sh` and
  `bash -n scripts/macos_uninstall_launch_agent.sh` passed.
- Installed the macOS LaunchAgent locally, resolved an existing manual uvicorn
  port conflict, and confirmed live health:
  `{"ok":true,"service":"kibitzer-server","mode":"idle","active_since":null}`.
- Refreshed LLM Wiki document/code snapshots with
  `bash scripts/refresh-llm-wiki-context.sh`.

Current boundary:

- macOS now has a login-start idle server path.
- Windows still uses manual server start; startup registration and tray status
  are planned but not implemented.
- The replay CLI remains the next cross-platform product milestone after the
  Windows daemon/tray pass.

## 2026-07-07 Alignment Controller And Dwell Merge

Session handoff:

- Added [handoff-2026-07-07-alignment-dwell.md](handoff-2026-07-07-alignment-dwell.md)
  as the durable summary of today's controller, dwell, verification, and runtime
  state.
- Preserved the original Korean Kibitzer implementation guideline as
  [kibitzer-implementation-guideline.md](kibitzer-implementation-guideline.md) and
  made it the first doc in [README.md](README.md).

Completed:

- Kept B안 as the configurable consecutive-drift controller.
- Corrected A안 to the original "cumulative alignment + hysteresis" design:
  `A_t = alpha * A_{t-1} + (1 - alpha) * r_t`, intervene below `theta_low`,
  recover above `theta_high`.
- Replaced the earlier window-count controller with `AlignmentController`.
- Added settings/API/popup support for:
  - A안: `alignment_alpha`, `theta_low`, `theta_high`;
  - B안: consecutive drift count `k`.
- Added legacy handling so stored `"window"` controller settings are interpreted
  as `"alignment"`.
- Merged `origin/main`, bringing in dwell-gated navigation judging and the macOS
  idle daemon runtime-resource changes.
- Pushed final `main` to `origin/main`.

Current navigation timing:

- A browser navigation observation updates the controller only after the active
  tab remains on the same URL for 5 seconds.
- Tier 2 excerpt confirmation waits until the same page has been active for 10
  seconds total and rechecks the active URL before extraction, submission, and
  notification display.

Verified:

- `python -m pytest` -> `68 passed`.
- `$env:Path = 'D:\Program Files;' + $env:Path; npm --prefix apps\extension run build` -> passed.
- Server restarted on `127.0.0.1:8765`.
- `/settings`, `/health`, and `/sessions/current/state` responded after restart.
- `git status --short --branch` was clean and synced with `origin/main` after
  push.

Next:

- Reload the Chrome extension after pulling, so the background service worker
  picks up dwell gating.
- Build the replay harness before further A/B/Page-Hinkley tuning.

## 2026-07-07 macOS Idle Daemon

Completed:

- Added the idle daemon plan covering `dead` / `idle` / `active`, the single
  process model, macOS LaunchAgent scope, and future Windows tray scope.
- Added lazy server runtime resources so startup stays idle and provider setup
  happens only after a goal-backed session starts.
- Moved `provider.degraded` recording from server startup to first runtime
  activation.
- Added `GET /health` runtime mode reporting.
- Added macOS LaunchAgent install/uninstall scripts for login autostart.

Verified:

- Runtime mode tests cover idle startup, activation on goal setting, return to
  idle on session end, and failed goal requests staying idle.
- PR #1 merged to `main` as `0317467`.
- Local LaunchAgent install was exercised and `/health` returned `mode: idle`.

## 2026-07-05 Status

Kibitzer Stage 0 is implemented through Work Package 8.

Completed:

- Project skeleton, docs, and LLM Wiki project-root integration.
- Local FastAPI server with sessions, declared goals, SQLite persistence, and event log.
- Chrome extension browser-navigation intake for committed navigations, SPA updates, and tab activation.
- Extension-side and server-side privacy gate for sensitive domains.
- CPU-only deterministic embedding provider and Tier 0 relevance scoring.
- Optional Tier 1 API classifier with minimized title/host payloads.
- Streak controller with coldstart, cooldown, and snooze state.
- Tier 2 excerpt handshake:
  - server returns `request_excerpt` only when the controller is ready to speak;
  - extension extracts a bounded page excerpt only on request;
  - server confirms or cancels with Tier 2;
  - raw excerpts are not persisted.
- Ollama Cloud Tier 2 provider wiring through `%KIBITZER_EXPERIMENT_MODELS_FILE%`.

Verified:

- `37 passed` from the Python server test suite.
- Extension TypeScript build passes with `tsc --noEmit`.
- Tier 2 dataset smoke passes 30 cases:
  - 18 notification scenarios;
  - 12 cancellation scenarios;
  - query strings and raw excerpt markers not persisted.
- Real Ollama Cloud Tier 2 provider call succeeds with `gemma4:31b`.
- Real HTTP Tier 2 flow succeeds from local server to Ollama Cloud and back to `notify`.
- LLM Wiki snapshots are refreshed and keyword search finds Tier 2 implementation pages.

Completed after this note:

- Work Package 9 notification and feedback loop:
  - extension shows Chrome notifications for server `notify` results;
  - notification actions send `related`, `accepted`, and `snooze` feedback;
  - server records duplicate-safe feedback;
  - `related` adds the observation embedding as a goal exemplar;
  - exemplar cap enforcement keeps the session exemplar set bounded;
  - `snooze` updates controller state so later drift is logged without immediate intervention;
  - notification messages are clamped to `delivery.max_sentences`.

Additional verification:

- Feedback API tests pass.
- Feedback smoke confirms:
  - `related` makes the next similar page judge OK;
  - `accepted` marks the intervention accepted;
  - `snooze` blocks the next intervention while keeping observation logging active;
  - raw excerpt markers are not persisted.

Current boundary:

- The browser navigation, Tier 0/1/2 judging, notification, and feedback loop are present for Stage 0.
- Feedback learning is session-local through goal exemplars.
- Permanent learning, dashboards, and replay tooling remain future work.

Next:

- Work Package 10: Replay CLI.
- Replay stored observations under alternate configs/controllers.
- Compare intervention points for regression and tuning.

## 2026-07-05 Extension Bundling

The Chrome MV3 extension now has a real loadable build output.

Completed:

- Added `esbuild` as an extension dev dependency.
- Added `apps/extension/build.mjs`.
- Updated the extension manifest to use paths relative to `dist/`.
- Updated package scripts:
  - `typecheck`: TypeScript type-check only;
  - `build`: type-check and emit bundled `dist/`;
  - `watch`: esbuild watch mode;
  - `test`: TypeScript type-check.
- Documented `npm install`, `npm run build`, `npm run watch`, and Chrome Load unpacked steps in the extension README.

Verified:

- `npm run build` emits `dist/manifest.json`, `dist/background.js`, `dist/popup/popup.html`, and `dist/icons/icon-128.svg`.
- `dist/background.js` is fully bundled with zero `import` statements.
- The excerpt extraction function remains inlined in the bundle.
- `dist/manifest.json` points to `background.js`.
- `npx tsc --noEmit` and `npm test` pass.
- Root `.gitignore` keeps `dist/` untracked.

## 2026-07-05 Session Lifecycle API, Icons, and Notification Polish

Completed:

- Session lifecycle and popup-support API:
  - `GET /sessions/current/state` reports goal presence, tracking status (`coldstart`/`tracking`/`snoozed`/`cooldown`), streak vs threshold, and snooze/cooldown deadlines;
  - `GET /sessions/current/stats` aggregates observation counts, OK/DRIFT split, related ratio, intervention counts, and top drift host;
  - `POST /sessions/current/snooze` snoozes without an intervention (`duration_seconds: 0` clears it) and logs a `session.snoozed` event;
  - `POST /sessions/current/end` deactivates the session, logs `session.ended`, and returns a session summary.
- Default snooze window is now 30 minutes (`snooze_seconds: 1800`) to match notification wording.
- Extension icons: the SVG face is rendered to PNG at 16/32/48/128; the manifest declares `icons` and `action.default_icon`; notifications use `icons/icon-128.png` because Chrome does not render SVG notification icons.
- Notification buttons now read `목표와 관련 있어요` / `잘 잡았어요` / `30분 조용히`.
- Toolbar badge: `!` when no session or no goal, `zZ` while snoozed, `?` when the local server is unreachable, empty while tracking quietly. The badge refreshes on service-worker wake, after each observation, after notification feedback, and on a 1-minute alarm.

Verified:

- `49 passed` from the Python server test suite, including new session lifecycle tests.
- `npm run build` bundles the badge code with zero `import` statements in `dist/background.js`, and PNG icons are copied into `dist/icons/`.

## 2026-07-05 Popup UI

Completed:

- Popup (`src/popup/popup.ts` + `popup.html`) implementing the full mockup scope:
  - one-line goal declaration that creates a session when none is active and sets the goal;
  - status pill for `coldstart` (with n/m progress), `tracking`, `snoozed`, `cooldown`, server-unreachable, and no-goal states;
  - drift streak gauge (filled dots against `streak_threshold`);
  - observation count and related-ratio stat cards;
  - snooze 30m / resume and end-session controls;
  - end-of-session summary view (duration, observations, related ratio, interventions, top drift host) with a new-goal restart;
  - 2-second polling while the dashboard is visible, paused while editing the goal.
- `build.mjs` bundles `src/popup/popup.ts` to `dist/popup/popup.js` alongside the background bundle.
- Popup actions ping the background service worker (`kibitzer:refresh-badge`) so the toolbar badge updates immediately.
- Extension API client gained session lifecycle calls (`createSession`, `setGoal`, `getCurrentSession`, `getSessionStats`, `postSessionSnooze`, `postSessionEnd`).

Verified:

- `npm run build` emits `dist/popup/popup.js` with zero `import` statements; type-check passes.
- Real HTTP smoke against the restarted local server:
  - `GET /sessions/current/state` and `/stats` return live data;
  - `POST /sessions/current/snooze` sets a 30-minute snooze, `duration_seconds: 0` clears it;
  - `POST /sessions/current/end` returns the summary and leaves no active session.

## 2026-07-05/06 First Real-Browser Dogfooding Fixes

Live testing against real browsing exposed four defects that server-side smokes could not catch:

- Excerpt extraction silently failed on every site: the manifest lacked general
  `host_permissions`, so `chrome.scripting.executeScript` always threw. Added
  `http://*/*` / `https://*/*`.
- Tier 0 judged goal-related Korean pages as DRIFT: whole-token hashing cannot
  match spacing variants ("크리에이트모드" vs "크리에이트 모드"). The hash embedding now
  adds Hangul character bigrams (`token-hash-v2`), embeds the title only (host
  tokens were whitelisting entire domains through the OK anchor), and `tau_ok`
  was recalibrated to 0.15 on real session titles (on-goal >= 0.207, off-goal <= 0.0).
  Verified on a live session: gallery/guide pages OK (0.24-0.85), YouTube/shopping DRIFT.
  Known miss: English titles for on-goal content stay DRIFT until Tier 1 is enabled.
- Chrome notifications never appeared: Chrome caps notification action buttons at 2
  and `chrome.notifications.create` throws with 3 (latent since Work Package 9).
  Buttons are now `related`/`snooze`; clicking the notification body sends `accepted`.
- The streak display could exceed its threshold (10/3) while interventions were
  gated by cooldown; the popup now clamps the display. The controller still logs
  the true streak.

Delivery observability and salience, prompted by a missed notification:

- `POST /interventions/{id}/delivery`: the extension reports whether
  `chrome.notifications.create` succeeded; the event log records `delivery.reported`
  and the intervention status becomes `delivered`/`delivery_failed`. Diagnosing
  "did the user ever see it" no longer requires guessing.
- Notifications are `requireInteraction: true` at max priority, and an offscreen
  document plays a short chime (`offscreen` permission, bundled `ding.wav`).
- Toolbar icon redesigned for visibility on dark toolbars: transparent background,
  light face with dark outline, green underline. macOS `qlmanage` turned out to
  bake an opaque white background into SVG thumbnails, so the PNG set is now
  produced by `scripts/gen_extension_icons.py`, a stdlib-only rasterizer of the
  same geometry with real alpha (verified corner alpha 0, circle coverage ~65%).

Verified:

- `51 passed` server tests, including the delivery-report endpoint.
- Extension bundles with the offscreen entry; real HTTP smoke on the restarted server.
- Real Tier 2 messages generated during live browsing, e.g. "마인크래프트와 관련 없는
  쇼핑 페이지입니다." (three interventions confirmed in ~2-3s each via Ollama Cloud).

## 2026-07-06 Pending-Intervention Fallback

Four interventions were delivered with `delivery.reported ok:true`, yet the user saw
none of them — Chrome succeeded, so suppression is at the macOS presentation layer
(programmatic verification of Notification Center settings failed on this macOS
version). Chrome notifications are therefore treated as best-effort, not the sole
delivery channel:

- `GET /sessions/current/state` now returns `pending_intervention` (latest
  intervention whose status is `pending`/`delivered`/`delivery_failed`, i.e. no
  feedback yet).
- The toolbar badge shows a red `1` while an intervention is unhandled (priority
  over the snooze badge).
- The popup renders the pending message with the three feedback actions
  (관련 있어요 / 잘 잡았어요 / 30분 조용히); feedback clears the badge.

Also observed in live logs and accepted as-is: a borderline false OK
("에이징커브 - YouTube", r0 exactly 0.15) caused by platform tokens (YouTube, 검색)
accumulating in the anchor. Raising `tau_ok` would flip genuinely related pages
(e.g. Refined Storage at 0.167) into DRIFT and produce false alarms, which the
thesis forbids; quiet false OKs are the acceptable failure mode. The anchor loop
is meanwhile absorbing related pages without any feedback clicks (용암 공장 0.231,
Aeronautics 0.274 judged OK purely via anchor).

Automation note: MCP-driven browser tabs are background tabs, which Kibitzer
correctly ignores (active-tab check) — full notification E2E cannot be driven
by the agent alone; the popup fallback makes delivery verifiable regardless.

Verified: `52 passed` server tests; extension bundle rebuilt; live state endpoint
returned the unacknowledged 03:48 intervention as `pending_intervention`.

Feedback loop confirmed live (2026-07-06 ~04:00 KST): an intervention was delivered
and accepted within 4 seconds, and the popup pending-card cleared a backlog of 8
unacknowledged interventions in 25 seconds (each feedback surfaced the next card).
A quiet period that followed was correct behavior: post-intervention cooldown plus
an on-goal page resetting the streak.

## 2026-07-06 Tier 1 Enabled (Local Ollama)

Tier 1 had never run: `enabled: true` but `${TIER1_BASE_URL}`/`TIER1_API_KEY` were
never set, and the factory silently returns `None` without credentials — zero
`tier1.classified` events in the database's entire history, all observations
`tier_reached=0`. Unlike Tier 2, Tier 1 never received the experiment models-file
integration in Work Package 8. Changes:

- `Tier1Config` supports `provider: "experiment"` with
  `experiment_models_file`/`experiment_model_key`; the experiment resolver is shared
  with Tier 2. Local URLs get a placeholder API key (local Ollama ignores auth).
- Default Tier 1 is now the local Ollama `gemma4:e4b` — no API cost, titles never
  leave the machine. `timeout_seconds: 10` caps hot-path latency, deliberately
  overriding the generation-oriented timeout in the models file.
- Per-call resilience: a Tier 1 provider failure keeps the Tier 0 verdict, records
  `tier1.provider_error`, and never fails the observation request.
- Startup observability: an enabled tier with no resolvable provider logs a warning
  and records a `provider.degraded` event (this made the two-day silent degradation
  visible in one query).

Verified:

- `55 passed` server tests (experiment resolution, error fallback, degraded event).
- Live HTTP: "Create - Minecraft Mods - CurseForge" (English title, the exact class
  Tier 0 misses) → Tier 0 DRIFT → Tier 1 reclassified OK with a Korean reason
  ("CurseForge는 모드 다운로드 사이트이다."), `tier_reached=1`; first call 7.9s
  including model load, warm calls expected in low seconds.
- No `provider.degraded` events on startup with the new config.

## 2026-07-06 Fun-Layer Planning Round

Product planning for the personality layer, split for parallel work (code: Codex,
design: Claude):

- [roadmap-fun-layer.md](roadmap-fun-layer.md): thesis (persona-driven contextual
  nagging for geek/ADHD users), stage overview P0/P1/P2, ownership boundaries,
  design principles.
- [handoff-p0-persona-engine.md](handoff-p0-persona-engine.md): Codex-executable
  now — persona loading/prompt composition, escalation context from the event log,
  runtime settings API, macOS `say` voice, quiet hours with the silent-delivery
  fallback.
- [handoff-p1-attachment-loop.md](handoff-p1-attachment-loop.md) (after P0):
  return celebration, "5분만" break, custom personas, session report API,
  judgment transparency.
- [handoff-p2-distribution.md](handoff-p2-distribution.md) (after P1, placeholder):
  status CLI/tmux, webhooks, cross-session learning decision, Replay CLI (WP10).
- [configs/personas.yaml](../configs/personas.yaml): v1 persona content authored —
  건조한 훈수꾼 (default), 오지랖 잔소리꾼, 조용한 코치 — style prompts with
  escalation rules, fallback templates, celebration templates (P1), voice params.

Claude's follow-up once P0 lands: popup UI for persona/voice/quiet-hours settings
and live tuning of the persona prompts against real Tier 2 output.

Next:

- Execute P0 (Codex), then popup settings UI (Claude).
- Work Package 10: Replay CLI (folded into P2).
- Session report history and local dashboard (folded into P1).

## 2026-07-07 P0 Persona Engine Plumbing

Implemented the P0 persona/delivery plumbing from
[handoff-p0-persona-engine.md](handoff-p0-persona-engine.md):

- Persona YAML loading with code-owned Tier 2 strict-JSON prompt composition.
- Runtime `/settings` API for persona, voice enablement, and quiet hours.
- Tier 2 escalation context (`nag_count_today`, ignored previous nag, drift minutes,
  repeat host) injected into the provider payload.
- Persona fallback templates for Tier 2 provider fallback, without editing
  `configs/personas.yaml` prose.
- Server-side macOS `say` voice hook, disabled by default, with persona voice/rate
  overrides when enabled.
- Quiet-hours suppression that still creates interventions and keeps the popup/badge
  fallback path alive via `silent: true`.
- Extension background handling for silent notifications; no popup changes.

Verified:

- `62 passed` from `.venv/bin/python -m pytest apps/server/tests -q`.
- `npm run build` passes in `apps/extension`.
- `grep -c silent apps/extension/dist/background.js` returns `2`.

## 2026-07-07 Dwell-Gated Judging

Changed extension-side navigation handling so accidental short visits do not start
judging:

- Browser navigation observations are posted only after the active tab remains on
  the same URL for 5 seconds, delaying Tier 0/Tier 1 work.
- Tier 2 excerpt submission waits until the page has been active on the same URL
  for 10 seconds total, so expensive confirmation does not run for brief visits.
- The tab URL is rechecked before excerpt extraction, before excerpt submission,
  and before notification display to avoid stale-page messages.

Verified:

- `npm --prefix apps/extension run build` passes.

## 2026-07-06 Persona Voice Redesign (Design Round)

User direction: drop mom-style nagging entirely; every voice should be calm on the
surface with a blade underneath. New benchmark set in `configs/personas.yaml`:

- `dry_kibitzer` (default) — British black humor: understatement, damning with
  faint praise, deadpan statistics ("오늘 세 번째군요. 꾸준하십니다.").
- `chungcheong` ("느긋한 이웃") — the essence of 충청도 화법 without dialect endings
  (user refinement): implicit, roundabout, half-said standard Korean; never
  escalates, gets shorter instead ("또 오셨네요. 마인크래프트는 어디 가고.").
- `kyoto` — 교토식 완곡 화법: flawless compliments that mean the opposite; repeat
  offenses make the compliments fancier ("이 사이트가 참 복도 많으시네요.").
- `quiet_coach` — unchanged shame-free ADHD option.

Live-sampled against the real Tier 2 provider (gemma4:31b) with escalation context
(3rd nag of the day, previous nag ignored, repeat host): all four personas produced
on-voice 1-2 sentence Korean messages and used page content as irony material
("노이즈캔슬링 덕분에 목표가 아주 정교하게 차단되었습니다"). A transient 2-test
failure during sampling was a race with the in-flight P0 edits; the full suite is
green afterwards. Server restarted with the persona engine live (default
`dry_kibitzer`, voice off, quiet hours off).

## 2026-07-06 Popup Settings UI

Completed (Claude, popup lane):

- Settings view in the popup (설정 button on the dashboard header):
  - persona selector cards (name + one-line tone hint, current selection outlined);
  - voice toggle with the macOS `say` hint;
  - quiet-hours toggle with HH:MM time inputs, disabled while off, and the
    "suppressed nags still land in the popup card" hint.
- Every control PUTs `/settings` immediately and re-renders from the server
  response; server unreachability falls back to the standard unreachable view.
- `api.ts` gained `getSettings`/`putSettings` with partial quiet-hours patches.
- The persona catalog (keys, display names, tone hints) is intentionally
  duplicated in `popup.ts` — same owner as `configs/personas.yaml` — until P1
  ships `GET /personas`.

Verified:

- Extension type-check and bundle green; settings wiring present in
  `dist/popup/popup.js`.
- Live PUT roundtrip: persona switch, partial quiet-hours patch, and rejection of
  an unknown persona (`400 unknown persona`).

Next:

- Human check: reload the extension, open the popup → 설정, switch persona, and
  browse to hear/see the new voice in a real intervention.
- Execute P1 after P0 soak (Codex).

## 2026-07-08 P1 Design Layer, Celebration Chime, and Doc Reconciliation

- Claude completed the P1 design handoff: celebration toast styling (happy-arc
  eyes, buttonless — also fixed the `[hidden]` vs `display:flex` bug that was
  showing feedback buttons on celebrations), `5분만` copy + button order, popup
  personas from `GET /personas`, pending-card "왜?" (tier1_reason) toggle, and
  the popup 리포트 view over `/sessions/current/report`.
- Fixed celebration delivery end-to-end: results returned on the browser-nav
  response were dropped by `handlePipelineResult`; the server was logging
  `celebration.delivered` with nothing displayed. Celebration gate is
  temporarily 0.5 min (dogfooding; target 3), and celebrations now play a soft
  two-note chime (`offscreen/celebrate.wav`) distinct from the nag ding.
- Doc reconciliation pass (supersedes stale claims in earlier entries): Windows
  startup + tray and the macOS menu bar status item are MERGED (the 2026-07-06
  "planned but not implemented" line below is outdated); delivery is the
  in-page toast with system notifications as fallback; tier judging runs on
  Ollama Cloud (nemotron-3-super / minimax-m3) with `.env` keys and 3-key
  rotation — the 2026-07-06 "Tier 1 Enabled (Local Ollama)" entry is history,
  not current state. READMEs, SETUP guides, platforms/architecture docs, and
  the docs index were aligned with the code in the same pass.


## 2026-07-08 P1 Attachment Loop: Page Labels

- Added the server-side always-on page verdict plumbing from
  `docs/handoff-p1-attachment-loop.md`: `GET /observations/latest?tab_id=`
  returns the current session's newest observation for that tab with verdict,
  Tier 0 diagnostics, anchor eligibility, and `tier1_reason`.
- Added observation-scoped `page_labels` storage plus
  `POST /observations/{id}/label` for `related`/`drift`. Re-labels update the
  single latest row; `related` labels add a goal exemplar through the existing
  feedback learning path, while `drift` labels remain record-only.
- Exposed matching extension API client types/functions for the Claude-owned
  popup card work.

Verified:

- `.venv/bin/python -m pytest apps/server/tests` passes (93 tests).
- `npm run build` in `apps/extension` passes.

## 2026-07-08 D5 Popup: 지금 페이지 Card + Dev Diagnostics (Claude)

- Popup dashboard now carries the always-on current-page card (D5 user layer),
  between the goal and the drift meter: page title/host, what the system
  currently believes (`관련 있다고 보는 중` / `이탈로 보는 중` / `아직 판단 전`
  with a green/amber/gray dot), and the two page-fact label buttons. Button
  copy agrees or disagrees with the displayed belief while always stating the
  page-fact: OK → `맞아, 관련 있어`/`아니, 이탈이야`, DRIFT → `아니, 관련
  있어`/`맞아, 이탈이야`, unjudged → prefix-free. After labeling: `관련 예시로
  기억해요` / `이탈로 기록해뒀어요 — 판정 개선에 써요`, and the chosen button
  stays highlighted (re-label = latest wins). Tabs with no observation get a
  muted `이 탭은 아직 관측 전이에요` + dwell hint, no buttons. Pull-only per
  the D5 guardrail — nothing prompts.
- Dev layer behind a `개발자 진단` settings toggle (persisted in popup
  `localStorage`, not server settings): 판정 단계 (`Tier 0 · 어휘 매칭` /
  `Tier 1 · LLM 재심` / `Tier 2 · 본문 확인`), `r0 / τ`, 예시 유사도, 앵커
  반영/제외, and the `판정 근거` (tier1_reason) sentence.
- Two small additive fields on `GET /observations/latest` to feed that card
  (Claude, outside the usual server boundary — flagged for Codex awareness):
  `tau_ok` (the Tier-0 threshold r0 was judged against, for the `r0 / τ` row)
  and `label` (current page label, so a reopened popup shows the already-saved
  state instead of silently forgetting it). Storage getter
  `page_label_for_observation` added; round-trip assertions extended in
  `test_page_labels.py`.

Verified:

- `.venv/bin/python -m pytest apps/server/tests` passes (93 tests).
- `npm run build` in `apps/extension` passes.
- Browser-preview harness (built popup.js + stubbed `chrome`/`fetch`): OK /
  DRIFT / unjudged / no-observation states, label click → POST → selected
  state + note, dev-toggle persistence, light + dark screenshots.

## 2026-07-08 Replay CLI: Per-session deterministic re-simulation

- Added `apps.server.app.replay` with an importable replay core and
  `python -m apps.server.app.replay` CLI. The source SQLite DB is opened via
  `mode=ro`; replay state (goal exemplars, anchor, controller state, and
  would-request-excerpt actions) stays in memory.
- Replay follows the logged event timeline: `goal.declared` resets the exemplar
  seed, `goal.exemplar_added` appends the replayed observation embedding with
  the configured cap, `session.snoozed` updates in-memory controller silence,
  and `observation.recorded` re-runs title-furniture stripping, hash embedding,
  Tier 0 score parts, recorded Tier 1 outcomes, anchor admission, and the
  controller with `now=obs.ts`.
- Added CLI support for `--list-sessions`, `--session` prefix resolution,
  `--latest`, repeated `--override dotted.path=value`, `--full`, `--csv`, and
  `--json`. `--live-tiers` is accepted only as a reserved follow-up flag; this
  patch replays recorded tier outcomes by default.
- Refactored `apply_controller(..., now=None)` so live behavior still uses the
  wall clock while replay injects the observation timestamp.
- Added deterministic replay tests for round-trip invariance through the API,
  threshold counterfactuals, exemplar timeline effects, recorded Tier 1 plus
  `tier1:no_recording`, and the read-only DB hash guarantee.

Verified:

- `.venv/bin/python -m pytest apps/server/tests -q` passes (104 tests).
- `.venv/bin/python -m apps.server.app.replay --db ./data/kibitzer.sqlite3 --list-sessions`
- `.venv/bin/python -m apps.server.app.replay --db ./data/kibitzer.sqlite3 --latest --full`
- `.venv/bin/python -m apps.server.app.replay --db ./data/kibitzer.sqlite3 --latest --override relevance.tau_ok=0.2 --csv /tmp/kibitzer-replay-latest.csv --json /tmp/kibitzer-replay-latest.json`

## 2026-07-09 Popup: Server-Offline Banner + Cached Dashboard (issue #11)

- The popup no longer blanks out when the local server is unreachable (the
  extension half of issue #11). Instead of the full-screen "연결 안 됨" note,
  every screen keeps rendering: a red banner on top (`서버 연결 안 됨 — 추적을
  사용할 수 없어요`), the header pill switches to `연결 안 됨`, and the 2s
  poll keeps running so reconnection stays automatic.
- The last successfully rendered dashboard (state + goal + stats) is cached in
  popup localStorage (`kibitzer.lastSnapshot`) and shown read-only while
  offline: server-dependent buttons (리포트/설정/수정/스누즈/세션 종료) are
  disabled, the pending nag card is suppressed (it may have expired and its
  feedback buttons need the server anyway), and the 지금 페이지 card shows
  `서버에 연결되면 표시돼요`. The snapshot clears once the server reports the
  captured session is gone (no session / no goal / session ended).
- With no snapshot (fresh install), the goal setup screen renders under the
  banner with 추적 시작 disabled; typed goal text survives both the reconnect
  poll (offline re-renders are skipped while the view kind is unchanged) and
  the offline→online transition.
- All unreachable failure paths (goal submit, snooze, session end, report,
  settings open/apply) now route through one handler instead of six copies of
  the full-screen error.

Verified:

- `npm run build` in `apps/extension` (typecheck + bundle).
- Browser-preview harness (built popup.js + stubbed `chrome` and a
  mode-switchable `fetch`): offline-no-cache setup screen, typing survival
  across ~18 poll cycles, offline→online auto-recovery to the live dashboard,
  online→offline cached dashboard (banner, disabled controls, hidden nag
  card), cold reopen while offline, light + dark screenshots, zero console
  errors.

## 2026-07-09 Toast Redisplay

- Implemented active-tab redisplay for pending intervention and celebration
  toasts. The background worker now keeps toast metadata and reinjects the latest
  pending toast after tab activation, top-frame load completion, or SPA URL
  updates.
- Delivery side effects stay single-shot: the first successful presentation
  reports intervention delivery and plays the sound; redisplays are quiet. A
  display token prevents stale hidden-tab timeout/dismiss events from clearing a
  newer active-tab toast.
- Verified by build/typecheck (`npm.cmd --prefix apps/extension run build`,
  `npm.cmd --prefix apps/extension run typecheck`) and a manual browser check:
  tab switching no longer makes the user miss a pending toast.
- Known polish notes: toast card sizing can vary slightly by tab/site for an
  unknown reason, and reinjection replays Kibitzer's entrance animation whenever
  the user switches back and forth while a toast is pending. Both are accepted
  for now.

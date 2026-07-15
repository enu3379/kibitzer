# Handoff — D7 Time-Budget Drift: Review Findings & Fix Order

**Audience:** Codex (or any agent) fixing the D7 implementation on `feature/time-budget-drift`.
**Reviewed commit:** `16e14bd` ("feat: add time-budget drift reviews") vs `origin/dev`.
**Design authority:** the D7 entry in [docs/planning-notes.md](planning-notes.md). Where a fix below touches design semantics it is flagged `DESIGN CALL` — confirm with the owner before deviating from the recommendation.
**Review method:** 8-angle parallel review + per-finding verification against the actual code. Every finding below was CONFIRMED by end-to-end tracing; line numbers refer to this branch at `16e14bd`.

## What is already correct — do NOT "fix" these

- Dual Tier-2 combination logic matches design: either judge saying "acceptable" defers the nag (`if not title.confirm_drift or not content.confirm_drift → defer`).
- Mode clock follows `controller.type` (alignment → cumulative, streak → continuous); continuous survives DRIFT→DRIFT navigations and resets on OK. Threshold math (`total = max(min_total, round(budget*60*fraction))`, `single_page = total // 2`, fallback 900s) matches the worked examples and tests.
- Privacy: the sensitive-domain gate runs before an observation exists, so `/content` can never receive text for a dropped URL; excerpt text never appears in `event_log`, session reports, or feedback rows; capture happens once per observation, never on heartbeats.
- Delivery machinery is shared: quiet hours, voice, snooze/cooldown checks, celebrations, and popup `pending_intervention` all work for D7-created interventions.
- Extension/server URL hashing is consistent (`urlPathHashFor` and `normalize_browser_nav` hash identical input; `privacy.strip_query` is a pre-existing dead knob, out of scope here).

## Primary findings (severity-ranked, fix in this order)

### 1. Review eligibility reuses the nav-event controller gate, so the flagship scenario can never fire

`apps/server/app/api/observations.py:379`, `apps/server/app/core/controller_flow.py:60`

`review_is_due` hard-requires `controller_is_eligible`, which reconstructs the navigation controller and calls `should_intervene` (streak: `obs_count ≥ coldstart_observations` AND `streak ≥ k`; alignment: requires `armed`, which only `update()` sets). Nothing on the presence path ever advances controller state. With shipped defaults (`k=3`, `coldstart=5` in `configs/default.yaml`):

- One navigation to a drift page (streak=1) + a 40-minute video → no review, ever. The design's single-page `total/2` valve is unsatisfiable by a single dwell.
- After a nag, `mark_controller_intervened` resets streak to 0 → continued dwell on the same page can never re-nag without 3 fresh drift navigations, contradicting the "re-judge at the next multiple of total" cadence.
- `apps/server/tests/test_d7_time_budget.py` only passes because it sets `ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0)`.

**Fix (DESIGN CALL, recommended):** for the D7 presence path, eligibility should check only snooze, cooldown, and coldstart — not `streak ≥ k` / `armed`. The mode clock itself already encodes the drift rule (it only accrues on DRIFT-verdict dwell), so the time thresholds are the trigger. Re-nags on the same page are governed by `next_review_mode_seconds` + cooldown, not by streak resets. Add a regression test that fires a review with `k=3, coldstart=5` after a single drift navigation plus heartbeats.

### 2. No presence event can re-activate the drift clock — accrual silently stalls, and any navigation anywhere steals the clock

`apps/server/app/storage/sqlite.py:1256` (drop gate), `apps/extension/src/background.ts:312` (recovery path posts `"heartbeat"`)

`record_drift_presence` drops any event whose observation doesn't match `drift_clock_states.active_observation_id` (`d7.presence_ignored`), regardless of kind. The only writer of `active_observation_id` is `activate_drift_clock`, which runs on **every** ingested navigation in **any** tab/window — so:

- Window-focus switches (Cmd-`) fire no `tabs.onActivated`; after the clock is cleared/reassigned, the still-viewed drift tab's heartbeats are dropped forever until it navigates. `heartbeatD7Observation`'s recovery path (`getLatestObservation`) posts kind `"heartbeat"`, which is dropped like any mismatch.
- A 5s dwell in another tab/window reassigns ("steals") the clock away from the drift tab the user returns to.

**Fix:** (a) extension: on the recovery path, post kind `"active"` instead of `"heartbeat"`; (b) server: accept an `"active"` presence as (re)activation when the referenced observation exists, belongs to the current session, and matches the event's `tab_id`/`url_path_hash` — set `active_*` columns from it (preserving `continuous`/`cumulative` per the same rules as `activate_drift_clock`). (c) Consider only activating the clock from navigations in the focused tab, or let the `"active"` re-activation path win; the clock must follow what the user is actually viewing.

### 3. Judge unavailable → permanent silence (regression: old path guaranteed a fallback nag)

`apps/server/app/api/observations.py:447` (`_confirm_d7_tier2` returns `None` on missing provider / `except Exception`)

With `time_budget.enabled: true` (the shipped default), `apply_controller(defer_intervention=True)` returns `NONE` instead of `REQUEST_EXCERPT`, making the D7 presence path the **only** nag path. If `create_tier2_judge_provider` returns `None` (no `configs/models.local.yaml` / keys) or the LLM errors, both gather results are `None` → `_defer_d7_review("judge_unavailable")` → no nag, repeated at every boundary. The old `_confirm_tier2` (still in the file, now unreachable) returned `Tier2Result(confirm_drift=True, message=format_persona_fallback(...))` in exactly this state.

**Fix (DESIGN CALL, recommended):** when both judges are unavailable AND thresholds are crossed, fall back to the persona-template nag (reuse `format_persona_fallback` / `fallback_drift_message`) so the pre-D7 guarantee holds. Combine with finding 9 (do not consume a review window on infra failure).

### 4. No window-focus / idle gating — drift accrues while the user is in another app (false-positive nags)

`apps/extension/src/background.ts:313`

Heartbeats are gated only by `chrome.tabs.query({active: true, lastFocusedWindow: true})` and `tabStillOnObservedPage` (checks `tab.active` + URL). Both stay true while Chrome is backgrounded: `lastFocusedWindow` matches the most recently focused Chrome window even when Chrome is not the OS-focused app, and `tab.active` is per-window. There is no `chrome.windows.onFocusChanged` or `chrome.idle` usage anywhere in the extension. 60s gaps never trip the 90s `max_heartbeat_gap_seconds` cap, so 30 minutes in an IDE accrues 30 minutes of "drift" and can fire a nag (toast + possibly voice) for a page nobody is viewing. This violates the project's "misses acceptable, false positives not" principle.

**Fix:** track OS focus via `chrome.windows.onFocusChanged` (skip heartbeats, or send `"inactive"`, when `windowId === chrome.windows.WINDOW_ID_NONE`) and gate on `chrome.idle.queryState` (skip when `"idle"`/`"locked"`; add the `idle` permission to the manifest). Server stays sole clock owner; the extension just stops asserting presence it can't vouch for. Pair with finding 2 so refocusing resumes accrual.

### 5. Per-page floor is "uninterrupted since activation", so routine tab-flipping makes `per_page` unsatisfiable

`apps/server/app/storage/sqlite.py:1191` (unconditional `current_page_drift_seconds = 0`), `background.ts:216` (departing tab's `"inactive"` also zeroes it)

Leaving a tab posts `"inactive"` (zeroes `current_page`); returning mints a new observation after the 5s dwell, and `activate_drift_clock` zeroes `current_page` again. A user who glances at another tab every <3 minutes never reaches `per_page_seconds=180`, and `review_is_due` short-circuits at `time_budget.py:51` even when the mode clock is far past `total` — both the total trigger and the `total/2` valve are blocked while cumulative drift grows unbounded.

**Fix:** treat per-page dwell as accumulated per page identity within the episode: in `activate_drift_clock` (and the `"active"` re-activation from finding 2), when the new observation's `url_path_hash` equals the previous `active_url_path_hash` and the verdict is DRIFT, preserve `current_page_drift_seconds` instead of zeroing. A genuine navigation to a different page still resets. Add a test: dwell 170s → tab flip → return → dwell 20s → review fires.

### 6. Missing excerpt defers the whole review instead of running the title-only judge

`apps/server/app/api/observations.py:405`

The excerpt check precedes payload construction: if `get_observation_excerpt` is empty, the review defers with `"content_unavailable"` to the next total multiple — at every boundary, indefinitely. The extension captures content exactly once per observation (`captureD7ContentAndActivate`; `postObservationContent` swallows failure with `.catch(() => null)`, no retry), so pages where `chrome.scripting.executeScript` fails (Chrome PDF viewer, Web Store, injection-blocked pages) can never be nagged — even though `build_d7_title_payload` needs no excerpt.

**Fix:** when the excerpt is missing, run the title judge alone and treat its verdict as authoritative (the "either acceptable defers" rule degenerates naturally to the one available judge). Optionally add one content-POST retry on the next heartbeat. Log `d7.content_unavailable` for observability but do not consume a window.

### 7. `reviewing` lock leaks on restart/exception — reviews permanently blocked for that page

`apps/server/app/api/observations.py:443` (unprotected window), `apps/server/app/storage/sqlite.py:1336` (`begin_d7_review`)

`begin_d7_review` persists `review_status='reviewing'` + `review_observation_id`; the handler then awaits two LLM calls (up to the tier2 timeout, ~180s). A server restart mid-await (`CancelledError` is `BaseException` and escapes `_confirm_d7_tier2`'s `except Exception`) or any unhandled exception between begin and defer/complete leaves the row locked. `review_is_due` returns `False` whenever `review_observation_id` is set (`time_budget.py:48`), and `activate_drift_clock` clears it only for a *different* observation — so the user parked on the drift page is never reviewed again until they navigate. There is no startup or periodic cleanup (`main.py` lifespan only calls `store.initialize()`).

**Fix:** wrap the review body in `try/finally` (on unexpected exit, clear the lock without advancing the boundary), and add a `review_started_at` column so `record_observation_presence` can expire a `reviewing` row older than, say, `tier2.timeout_seconds + heartbeat interval` before evaluating `review_is_due`.

### 8. Stale `next_review_mode_seconds` survives the mode-clock reset it indexes

`apps/server/app/storage/sqlite.py:1180` (continuous reset on OK; the UPDATE never touches `next_review_mode_seconds`)

Streak mode, `total=900`: drift reaches 1000s, Tier-2 judges it acceptable → defer sets `next_review_mode_seconds=1800`. The user returns to on-goal pages (continuous → 0), then starts a **new** drift episode: the `mode_seconds < next_review_mode_seconds` guard (`time_budget.py:53`) now demands 1800s of uninterrupted drift — 2× total — before any review, and blocks the `total/2` valve the whole time. The "next multiple of total" boundary was defined against a clock that no longer exists.

**Fix:** whenever the mode clock resets (OK verdict in streak mode in `activate_drift_clock`; also `reset_drift_clock_state`), reset `next_review_mode_seconds` to 0 (and clear `last_defer_reason`). Alignment mode is unaffected (cumulative never resets mid-session).

### 9. Infrastructure failures consume a full review window

`apps/server/app/storage/sqlite.py:1363` (`defer_d7_review` advances unconditionally), `apps/server/app/api/observations.py:679` (`_defer_d7_review` same boundary for all reasons)

`judge_unavailable` and `content_unavailable` advance `next_review_mode_seconds` exactly like a genuine "acceptable" judgment. A 1-second provider hiccup at the boundary postpones any possible nag by up to a full `total` (up to 20+ minutes of budget); repeated hiccups compound. planning-notes.md scopes next-multiple re-judging to *acceptable* deferrals only.

**Fix:** split defer kinds. Only an actual acceptable judgment advances the boundary; infra failures clear the `reviewing` lock but leave `next_review_mode_seconds` unchanged so the review retries at the next heartbeat (optionally with a one-heartbeat backoff). Note: findings 3 and 6 reduce how often infra-failure defers happen at all.

### 10. Goal re-declaration wipes snooze, coldstart progress, and all clocks

`apps/server/app/storage/sqlite.py:836` (controller reset), `:865` (`reset_drift_clock_state`)

`set_current_goal` now unconditionally resets `controller_states` (streak, obs_count, `last_intervention_ts`, **`snoozed_until`**, alignment) plus the drift clock on every goal POST — `origin/dev` touched only goal tables. The popup's 수정 (edit) button re-POSTs `/sessions/current/goal` for the same session, so fixing a typo cancels an explicitly-requested snooze, re-enters 5-observation coldstart, and zeroes accumulated budget clocks. This regresses even with `time_budget` disabled.

**Fix (DESIGN CALL, recommended):** restore dev behavior for `controller_states` on re-declaration (at minimum never NULL `snoozed_until`). For the drift clock, resetting on a *changed* goal/budget is defensible; skip the reset when goal text and budget are unchanged, or only reset budget-derived fields when `available_time_minutes` changes.

## Secondary findings (below top-10 cutoff — fix opportunistically, each is small)

- **Unbounded tables** (`sqlite.py:1251`): `dwell_presence_events` (one row per presence event, kept only for `event_id` dedup) has no DELETE anywhere; each heartbeat also appends a `d7.presence_recorded`/`d7.presence_ignored` `event_log` row. ~120 rows/hour of active browsing, forever. Prune `dwell_presence_events` on session end (like excerpts) and/or keep only a recent window per session; consider dropping the per-heartbeat event_log rows or sampling them.
- **Excerpts survive implicit session end** (`sqlite.py:255`): `create_session` ends an active session via `UPDATE sessions SET active=0` without the `DELETE FROM observation_excerpts` that `end_current_session` (`:310`) performs; session rows are never deleted so the CASCADE is dead. This contradicts the claims this diff added to `docs/data-model.md` ("excerpts are deleted with their session") and `docs/privacy.md`. Delete excerpts in `create_session`'s implicit-end path too.
- **Dead `heartbeat_seconds` knob + silent clock slowdown** (`apps/server/app/config.py:116`, `background.ts:650`): the knob is only used by a validator; the extension hardcodes `periodInMinutes: 1`. If a user lowers both `heartbeat_seconds` and `max_heartbeat_gap_seconds` to 45, every 60s gap is clamped to 45s and all clocks run at 75% speed with no warning. Either serve the value to the extension (e.g. in the session-state payload; `chrome.alarms` supports 0.5-min periods) and derive the alarm from it, or delete the knob and define `max_gap` relative to the fixed 60s cadence.
- **`nagging_context` lost** (`apps/server/app/core/tier2_payload.py:33`): D7 payloads omit `nag_count_today` / `last_nag_ignored` / `repeat_host` (`_inject_nagging_context` is only called on the legacy `/excerpt` path), so repeat-offense escalation is gone. Inject the same context into both D7 payload builders (drift duration is already covered by the `time_budget` context block).
- **Replay divergence** (`apps/server/app/replay/core.py:659`): replay calls `apply_controller` without `defer_intervention`, so replaying a D7-recorded session reports `request_excerpt original/replay: 0/N`. Pass the config's `time_budget.enabled` through, or annotate the report that D7 sessions aren't modeled.
- **Heartbeat hot-path waste** (`apps/server/app/api/observations.py:341`): each presence request loads the full goal record including exemplar/derived-exemplar embedding vectors just to read `available_time_minutes`; the controller is rebuilt twice per notifying review (`controller_is_eligible` then `mark_controller_intervened`); OK-verdict/no-goal tabs still heartbeat and write rows every minute (the extension tracks all verdicts — gate `captureD7ContentAndActivate`/heartbeats on DRIFT, or at least skip the DB writes server-side for non-DRIFT active verdicts); MV3 SW teardown makes most heartbeats take the untracked recovery path (GET `/observations/latest` + double SHA-256 per beat).
- **Triplicated excerpt normalization**: `" ".join(text.split())[:limit]` exists in `sqlite.py:1035` (`store_observation_excerpt`) and `tier2_payload.py:81` (`_clean_excerpt`), with a third normalize+truncate in `readabilityExtract.ts:15` (3500-char slice). Extract one server-side helper; leave the extension's pre-truncation as a transport bound.
- **Missing `intervention.request_excerpt` event** (`apps/server/app/core/controller_flow.py:33`): the defer branch returns before `record_intervention_requested`, so controller triggers leave no event-log trace in D7 mode (only `d7.review_started` much later). If replay parity matters, log a distinct `intervention.deferred` event in the defer branch.

## Hard constraints

- Do not change these design semantics (see planning-notes.md D7): either judge "acceptable" → defer; mode clock follows `controller.type`; sub-`per_page` dwell still counts toward the mode clock; acceptable deferrals re-judge at the next multiple of `total`; server owns all clocks/decisions, the extension is an event relay.
- Behavior with `time_budget.enabled=false` must remain exactly the legacy pipeline (fix 10's regression applies here too).
- Never commit secrets; `configs/models.local.yaml` and `.env` stay local.
- Update `docs/architecture.md` / `docs/data-model.md` / `docs/privacy.md` if a fix changes any claim they make (the retention fix above brings code in line with the docs; prefer that direction).

## Acceptance checks (agent-runnable)

```sh
python -m pip install -e ".[test]"
python -m pytest apps/server/tests -q         # all green
cd apps/extension && npm ci && npm run build  # tsc --noEmit + esbuild green
```

Add regression tests (in `apps/server/tests/test_d7_time_budget.py` unless noted):

1. Single drift navigation + heartbeats fires a review under `k=3, coldstart=5` once `total/2` is reached (finding 1).
2. An `"active"` presence re-activates a cleared/stolen clock and subsequent heartbeats accrue (finding 2).
3. Both judges unavailable at threshold → user still gets a nag (fallback), and `next_review_mode_seconds` does not advance (findings 3, 9).
4. Tab flip away/back on the same `url_path_hash` preserves `current_page_drift_seconds` (finding 5).
5. Missing excerpt → title-only judgment runs; confirm_drift from the title judge alone produces a nag (finding 6).
6. A stale `reviewing` row older than the expiry window does not block `review_is_due` (finding 7).
7. OK-verdict activation in streak mode resets `next_review_mode_seconds` (finding 8).
8. Re-POSTing an identical goal preserves `snoozed_until` and `obs_count` (finding 10).

Extension-side changes (findings 2, 4, 6, secondary items) are not covered by automated tests — list manual verification steps in the PR description (background/idle Chrome stops accrual; window refocus resumes it).

## Manual follow-ups for the human

- Findings 1, 3, and 10 are flagged DESIGN CALL above; the recommendations match the D7 design's intent as recorded in planning-notes.md, but confirm before merging if you disagree.
- The `idle` permission addition (finding 4) changes the extension's permission set — re-load the unpacked extension after building.

## Adjacent in-flight work

- This branch also carries `cfb0eba` (D7 design entry in `docs/planning-notes.md`) — the design authority for this handoff.
- Branch `codex/d7-structure-review` holds a separate structure-review handoff (`docs/handoff-d7-structure-review.md`); it is read-only context, no merge dependency.
- PR target is `dev` (squash merge; PR title must be Conventional Commits, e.g. `feat: add time-budget drift reviews`). Check the AI-assisted box in the PR template.

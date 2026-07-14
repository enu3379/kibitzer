# D7 time-budget drift rule — structure review

**Scope.** This is an analysis-only review of D7 as specified in
`docs/planning-notes.md` and `docs/handoff-d7-structure-review.md`.  It is
based on the current branch source, not on a proposed implementation.  The
short conclusion is that D7 fits Kibitzer's server-as-source-of-truth model,
but it must be introduced as a durable *time review gate* beside the existing
event controller.  Adding elapsed-time checks to `should_intervene()` alone
would be incorrect: the current controller consumes its state and starts its
cooldown before Tier 2 has decided whether to defer.

## 1. Current path: navigation to notification

The following is the actual path, including the clocks and state transitions
that matter for D7.

```text
top-frame navigation / active-tab switch
  -> extension pending-tab token + observation dwell
  -> local sensitive-domain drop
  -> POST /observations/browser-nav
  -> server sensitive-domain drop, normalize, Tier 0 and optional Tier 1
  -> persist observation; update event controller
  -> none | request_excerpt | celebration
  -> (request_excerpt only) extension extracts page body after Tier-2 dwell
  -> POST /observations/{id}/excerpt
  -> single Tier-2 confirmation
  -> intervention row, delivery, feedback / snooze
```

### Extension timing and navigation state

1. `background.ts` listens to top-frame `webNavigation.onCommitted` and
   `onHistoryStateUpdated`; it also starts a new observation for the activated
   tab (`apps/extension/src/background.ts:637-655`).
   `scheduleTabObservation()` clears the old timer for that tab, gives the new
   candidate an in-memory token and `startedAt`, and clears candidates in other
   tabs on activation (`:69-94`, `:187-199`).  A token/url/active-tab recheck
   prevents a stale delayed callback from being sent.
2. `scheduleDwellCheck()` first obtains server settings, writes local
   exploration history, and starts a `setTimeout` for
   `dwell.observation_seconds` (`:96-156`).  The default is **5 s**
   (`:22`, `configs/default.yaml:103-105`; allowed range 1–300 s in
   `apps/server/app/config.py:103-105`).  The callback rechecks that the tab
   remains active and has the same URL, then posts only `url`, `title`, and
   `tab_id` (`apps/extension/src/lib/api.ts:347-356`).  Both extension and
   server drop configured sensitive domains before an observation is retained
   (`background.ts:96-100`; `observations.py:143-158`).
3. A `request_excerpt` result enters `handlePipelineResult()`
   (`background.ts:224-251`).  It waits
   `tier2DwellMs - (now - startedAt)`, rechecks the active tab and exact URL,
   extracts up to 3,500 client-side characters, then posts the excerpt.
   Although the D7 note calls the old path “5 s observation + 10 s Tier 2”,
   the implementation treats `tier2_seconds` as a **total time since
   `startedAt`**.  With defaults it normally reaches extraction at about 10 s
   after navigation (roughly 5 s after the observation request), not 15 s.
   `tier2_seconds` defaults to 10 and is also range-limited to 1–300 s.
4. There is already an `alarms` permission and a one-minute
   `kibitzer-badge-refresh` alarm (`manifest.json`; `background.ts:575-590`),
   but it calls only `GET /sessions/current/state` to redraw the badge.  It is
   not a page-presence heartbeat and it does not advance server clocks.
   All pending observation and excerpt timers live in service-worker memory;
   they disappear on a worker teardown.

### Server classification and event controller

1. `POST /observations/browser-nav` first applies the authoritative sensitive
   domain decision, exits if there is no active session, and normalizes the
   privacy-minimized browser payload (`apps/server/app/api/observations.py:143-161`).
2. With a goal, it embeds the normalized title/host text, computes Tier 0 from
   declared exemplars, the OK anchor, and derived exemplars, and sets
   `OK` when `r0 >= relevance.tau_ok` (`observations.py:163-190`).  The shipped
   `tau_ok` is **0.15** (`configs/default.yaml:59-67`; model default in
   `config.py:28`).
3. Only a Tier-0 `DRIFT` calls Tier 1.  Tier 1 gets the current title/host and
   up to **five** recent title/verdict summaries; a successful judgment maps
   the controller relevance to 0.85 (OK) or 0.0 (DRIFT).  A provider failure
   retains Tier 0's result (`observations.py:191-218`,
   `core/tier1_payload.py:8-35`, `configs/default.yaml:20-42`).
4. The server persists that observation before it invokes
   `apply_controller()` (`observations.py:234-241`; `storage/sqlite.py:901-954`).
   `controller_states` holds one row per session with `streak`, `obs_count`,
   `last_intervention_ts`, `snoozed_until`, `alignment_score`, and
   `drift_latched` (`storage/sqlite.py:89-98`, `1787-1796`).  It has no
   current-page identity, presence timestamp, elapsed dwell, or threshold
   boundary.
5. With `controller.type=streak`, `StreakController.update()` increments on
   each DRIFT and resets to zero on OK.  `should_intervene()` requires
   `obs_count >= coldstart_observations`, `streak >= k`, no active snooze, and
   no active cooldown (`core/controllers/streak.py:17-35`).  Shipped settings
   are **k=3**, **coldstart=5 observations**, **cooldown=300 s**, and
   **snooze=1,800 s** (`configs/default.yaml:85-93`).
6. With `controller.type=alignment`, `AlignmentController.update()` keeps an
   EWMA with `alpha=0.85`; it arms when the score crosses below
   `theta_low=0.15`, latches drift, and only clears the latch/armed state once
   it rises above `theta_high=0.30` (`core/controllers/alignment.py:19-49`).
   It shares coldstart, snooze, and cooldown gates.  Thus “alignment” is an
   event rule today, not a cumulative-time clock.
7. If either event controller intervenes, `apply_controller()` immediately
   calls `on_intervened()`, saves state, records
   `intervention.request_excerpt`, and returns `request_excerpt`
   (`core/controller_flow.py:51-70`).  Streak thereby resets to zero;
   alignment's `armed` resets to zero.  Crucially, this happens **before** the
   excerpt arrives and before Tier 2 can cancel the nag.  The resulting
   `last_intervention_ts` starts the 300-second cooldown even if Tier 2 later
   finds the page acceptable.

### Excerpt, Tier 2, delivery, and return celebration

1. `POST /observations/{id}/excerpt` accepts a page excerpt only for the
   current session's DRIFT observation (`observations.py:279-299`).  It builds
   one Tier-2 payload: goal, current page metadata, five recent title/verdict
   entries, and the **current** excerpt cleaned and capped to 3,000 characters
   (`core/tier2_payload.py:8-30`; `configs/default.yaml:44-57`).  Excerpts are
   transient: neither `observations` nor any other SQLite table stores them.
   That agrees with the current privacy documents, which explicitly say not
   to persist excerpts (`docs/data-model.md`, `docs/privacy.md`).
2. `_inject_nagging_context()` adds `minutes_since_last_ok`, nag count, last
   nag ignored, and repeat host (`observations.py:486-497`).  This existing
   “drift minutes” is a display/context calculation from the latest OK
   observation (`storage/sqlite.py:495-511`); it is not an accrued dwell clock
   and is not a trigger condition.
3. A single Tier-2 judge returns `confirm_drift`.  False returns `none`; true
   writes a Tier-2 event, creates an intervention row, and returns `notify`
   (`observations.py:301-363`).  The current provider-error fallback instead
   returns a confirmed drift/message (`:455-483`), so a Tier-2 outage can
   produce a nag.  Quiet hours suppress visible delivery but still create the
   intervention; optional voice is a delivery side effect.
4. In parallel with the controller bookkeeping, an observation updates
   `attachment_states`.  A later OK after a confirmed enough drift run may
   create a direct celebration notification if it exceeds
   `celebration.min_drift_minutes` (currently 0.5 min) and its separate
   300-second celebration cooldown (`observations.py:241-252, 398-445`,
   `storage/sqlite.py:513-581`, `configs/default.yaml:95-99`).  Celebration
   does not request an excerpt or call Tier 2.
5. Delivery feedback can add a related exemplar, mark accepted, or set
   `snoozed_until`; snooze and break retain the rest of the controller state
   (`api/feedback.py:39-121`).  The controller classes' `on_feedback()`
   methods are not called by that route, so D7 should not assume feedback
   currently resets controller eligibility.

## 2. Fit with D7

### Clean integration points

- **Ownership is right.** The local server already owns sessions, goals,
  controller state, interventions, and the SQLite event log.  A heartbeat may
  be an extension relay, but all elapsed-time arithmetic and threshold
  decisions can remain server-side, preserving the stated SSOT boundary.
- **There is a good semantic input.** Tier 0/Tier 1 already produce a durable
  final `OK` or `DRIFT`, and `controller.type` already selects streak versus
  alignment (`observations.py:163-218`, `controller_flow.py:26-51`).  D7 can
  use that same final verdict to start/stop clocks without moving relevance
  decisions into the extension.
- **Persistence and configuration already have seams.** `SQLiteStore` uses
  additive, idempotent column migrations (`sqlite.py:1927-1947`), and
  `ControllerConfig`, `Tier2Config`, and `DwellConfig` are separate Pydantic
  models (`config.py:70-105`).  Goal declaration and state responses are
  centralized in `api/sessions.py:21-35, 387-410`.
- **The required browser primitive already exists.** `alarms` permission is in
  the manifest, and navigation/activation plus exact-page checks are already
  implemented.  A 30–60-second alarm can therefore relay presence without
  trying to make an MV3 `setTimeout` reliable.
- **Tier 2 has an explicit payload seam.** Splitting
  `build_tier2_payload()` into title and content builders is localized.  The
  existing `recent_observation_summaries()` query (`sqlite.py:1548-1564`) is a
  direct place to add bounded recent content context.

### Structural resistance and required changes

1. **The current controller is a one-shot event gate, not a review scheduler.**
   It receives only a classified navigation.  It has neither page-presence
   updates nor elapsed state.  More importantly, it mutates/reset state before
   Tier 2.  A D7 deferral therefore cannot faithfully mean “retry at the next
   multiple of total”: it has already reset streak or alignment `armed` and
   entered cooldown.  For alignment, a latched low score with `armed=0` will
   not rearm while it remains low, so recurring reviews are especially
   incompatible with the present `on_intervened()` behavior.
2. **There is no trustworthy active-page lifecycle on the server.** The server
   sees a nav only after the 5-second dwell.  It sees neither a tab becoming
   inactive nor a continued stay on the page.  The background map and
   `setTimeout` are intentionally ephemeral, which is appropriate today but
   cannot survive MV3 teardown, sleep, or a long reading interval for D7.
3. **The planned evidence does not exist.** Tier 2 receives only the current
   excerpt, and it is discarded.  D7's content judgment needs the recent `j`
   excerpts plus current excerpt.  This reverses a current explicit privacy
   guarantee, so it needs an intentional retention bound and updates to
   `docs/data-model.md`, `docs/privacy.md`, and the user-facing privacy copy;
   it must not be treated as a hidden payload tweak.
4. **The protocol has no representation for D7 state.** `PipelineAction` has
   only `none`, `request_excerpt`, and `notify` (`schemas.py:60-84`).  There is
   no durable pending-time review, deferred review boundary, heartbeat
   idempotency key, or status for “currently drifting but below per-page
   threshold”.  Reusing `pending_intervention` would be misleading because it
   means a created intervention awaiting delivery/feedback.
5. **Goal storage/API lacks the optional budget.** `GoalRequest`, `GoalRecord`,
   `goals`, the extension `setGoal(rawText)`, and popup setup/edit UI carry
   only text/keywords (`api/sessions.py:21-35`, `storage/sqlite.py:34-48,
   746-810`, `apps/extension/src/lib/api.ts:165-172`,
   `popup/popup.ts:274-322`).
6. **D7's stated clock origin needs one explicit resolution.** The design says
   excerpts are captured after the 5-second observation dwell, but also says
   Tier 0/1 marks drift from an approximately 15-second observation point.
   Current source actually classifies at 5 s and (when requested) extracts at
   about 10 s after navigation.  Use one server event as the only clock origin:
   the timestamp at which the server records the final Tier-0/1 verdict.  This
   avoids retroactively counting unclassified/sensitive pages and removes the
   ambiguous 15-second premise.

## 3. Recommended D7 design and implementation order

### Contract decisions to lock before coding

Use seconds internally and derive a single threshold object per session:

```text
total_seconds = max(min_total_seconds, available_time_seconds * total_fraction)
                when a budget exists
              = fallback_total_seconds otherwise
per_page_seconds = configured value
single_page_seconds = total_seconds / 2
mode_clock = continuous_drift_seconds  (streak controller)
           | cumulative_drift_seconds  (alignment controller)
```

Recommended defaults preserve D7: `total_fraction=1/6`,
`min_total_seconds=300`, `fallback_total_seconds=900`, and
`per_page_seconds=180`.  All use integer seconds with a documented rounding
rule.  A very short budget may make `total / 2 < per_page`; the per-page floor
still wins, which is the expected effective earliest review.

Start accumulating only when the server has recorded a final DRIFT verdict for
the active page.  An OK resets `continuous_drift_seconds` but never resets
`cumulative_drift_seconds`; a new active page resets only the per-page value.
Do **not** reset either D7 clock merely because a review was requested,
deferred, or notified.  The existing event controller still supplies the D7
“drift-rule condition”; it must be refactored so that it reports eligibility
without performing the delivery-side reset until an actual notification is
created.

The initial review predicate should be:

```text
event_rule_is_eligible
and current_page_drift >= per_page
and (mode_clock >= total or current_page_drift >= total / 2)
and mode_clock >= next_review_mode_seconds
```

`next_review_mode_seconds` starts at zero.  If either Tier-2 judgment says
acceptable, set it to `(floor(mode_clock / total) + 1) * total`.  This blocks
an immediate repeat caused by a page remaining above the `total/2` escape
valve, while exactly implementing the next-total-multiple rule.  Delivery
cooldown remains a separate anti-spam gate after a confirmed notification.

### Storage and API shape

Use two small durable records plus the existing tables; do not log raw body
text in `event_log`.

```text
goals
  + available_time_minutes INTEGER NULL

drift_clock_states (one row per session)
  session_id PK / FK
  active_observation_id FK NULL
  active_tab_id INTEGER NULL
  active_url_path_hash TEXT NULL
  active_since_at TEXT NULL
  last_heartbeat_at TEXT NULL
  current_page_drift_seconds INTEGER NOT NULL DEFAULT 0
  continuous_drift_seconds INTEGER NOT NULL DEFAULT 0
  cumulative_drift_seconds INTEGER NOT NULL DEFAULT 0
  next_review_mode_seconds INTEGER NOT NULL DEFAULT 0
  review_observation_id FK NULL       -- one review currently awaiting result
  last_presence_event_id TEXT NULL    -- retry/idempotency guard
  updated_at TEXT NOT NULL

observation_excerpts
  observation_id PK / FK
  session_id FK
  captured_at TEXT NOT NULL
  text TEXT NOT NULL                  -- normalized and bounded before insert
  char_count INTEGER NOT NULL
```

`drift_clock_states` is deliberately separate from `controller_states`: the
latter remains the event-rule state and can retain replay compatibility, while
the former makes D7's state names and migration/recovery rules explicit.
`observation_excerpts` should be inserted for every non-sensitive, successful
observation capture, then pruned transactionally to the configured recent
content window (at least `j` plus the current item) or deleted at session end.
This keeps "every observation" available when it can affect a review without
silently retaining a full session of page body.  If product requirements truly
mean full-session retention, that must be a separately approved privacy
decision rather than a schema default.

Add a server-owned presence endpoint, for example
`POST /observations/{id}/presence`, carrying a server-issued page identity,
`tab_id`, `window_id`, `kind` (`active`, `heartbeat`, `inactive`), and a UUID
event id.  The server uses receipt time, never a client clock.  It accepts an
event only when its observation/tab/path identity is current and records an
idempotent interval update.  A heartbeat updates the active visit, accrues at
most a configured heartbeat/grace interval, and evaluates the predicate.
The cap prevents sleep, server downtime, or a delayed alarm from being
mistaken for focused reading.  A visit/interval audit table is optional; the
aggregate state plus non-content `dwell.*` events is the simpler first
implementation.

Make content capture a separate endpoint from the existing Tier-2 confirmation
endpoint.  Immediately after a qualifying observation response, the extension
captures the bounded excerpt once (after the existing 5-second observation
dwell) and posts it for storage.  Later a due review reads stored current and
recent excerpts; it does not request a late, potentially changed page body.
The server must recheck that the observation is eligible and cap/normalize
before persistence.  Keep the extension's local sensitive-domain check, but
make the server check authoritative and test both rule sets for parity.

At a due review, build two explicitly typed inputs and run the provider calls
with `asyncio.gather`:

- **title judgment:** goal, time-budget/clock context, current title, and
  recent title/verdict sequence;
- **content judgment:** the same goal/time context, bounded current excerpt,
  and bounded recent excerpt sequence.

Each result must distinguish `acceptable`, `not_acceptable`, and
`unavailable/error`; it cannot be just the existing `confirm_drift: bool`.
Only two `not_acceptable` results create an intervention.  Either acceptable
result writes a durable D7 deferral and advances `next_review_mode_seconds`.
For the product's false-positive preference, an unavailable content/title
judgment should also defer with an auditable reason, rather than use the
current provider-error fallback that nags.

### Concrete transition and HTTP contract

The implementation should make these transitions explicit and testable. They
are intentionally separate from the existing delivery `pending_intervention`
state:

| Event | Clock transition | Review transition |
| --- | --- | --- |
| Final classified `OK` observation becomes active | Close/rebase the previous visit; reset only `continuous_drift_seconds`; clear current-page drift. | Clear an obsolete pending review for the old page. |
| Final classified `DRIFT` observation becomes active | Create/rebase its visit at server receipt time; current-page drift begins at zero. | Remain `below_per_page` until the first qualifying presence interval. |
| Idempotent heartbeat for the current page | Add a bounded interval to current-page, continuous, and cumulative clocks. | Evaluate event eligibility and the time predicate. |
| Predicate is due, content is available | Freeze the page/clock snapshot under `review_observation_id`. | Run the two Tier-2 calls once. |
| Either judgment is acceptable or unavailable | Leave clocks intact; set the next total-multiple boundary. | `deferred` with a reason; no delivery cooldown. |
| Both judgments are not acceptable | Leave clocks intact; create intervention and then record delivery cooldown. | `notified`; clear the in-flight review. |
| Inactive, URL replacement, tab close, focus loss, or long heartbeat gap | Close/rebase the active visit without attributing the unknown gap. | Keep only a still-valid deferred boundary; cancel an in-flight review whose page identity no longer matches. |

Use two new endpoint contracts rather than overloading an excerpt confirmation
call with both storage and policy:

```json
POST /observations/{observation_id}/content
{
  "title": "optional page title",
  "text": "bounded client extraction"
}
```

The server returns a content receipt only after checking that the observation
belongs to the active session, was not a sensitive-domain drop, and applying
the configured storage cap. It must not run Tier 2.

```json
POST /observations/{observation_id}/presence
{
  "event_id": "uuid",
  "kind": "active | heartbeat | inactive",
  "tab_id": 123,
  "window_id": 4,
  "url_path_hash": "the observation identity"
}
```

The presence response can remain a `PipelineResult`: normally `action=none`,
and `action=notify` only after the server's D7 review has confirmed drift.
Expose a separate time-state object from `GET /sessions/current/state` for UI
diagnostics: controller mode, configured thresholds, current-page seconds,
mode-clock seconds, `below_per_page | eligible | reviewing | deferred`, and
the next review boundary. Do not expose excerpts in that response.

This also gives a safe deployment/migration rule. A newer server must accept
an older extension's navigation posts without assuming a heartbeat or content
exists; it simply makes no time-based intervention. A newer extension talking
to an older server should treat a 404/422 from the two new endpoints as a
non-fatal no-op, exactly as the extension already treats unreachable local
server calls. Once both halves are current, D7 activates. Existing SQLite
rows get NULL budgets and zeroed clocks, which selects the 15-minute fallback
rather than changing a historical session's semantic meaning.

### Acceptance examples that the implementation must prove

1. **No budget, streak mode:** once the five-observation coldstart is complete,
   three semantically DRIFT observations make the event rule eligible, but a
   179-second current page does not ask Tier 2; at 180 seconds it still waits
   until total drift reaches 900 seconds unless that same page reaches 450
   seconds.
2. **Worked 20/3 example, alignment mode:** at 3 + 3 + 4 minutes across drift
   pages, a page with at least 3 minutes triggers at the 10-minute valve. If
   either judge accepts it, the same page cannot retrigger before the
   20-minute mode-clock boundary.
3. **Streak reset:** a final OK resets only the continuous clock. It does not
   decrease alignment's cumulative clock, and a navigation/intervention alone
   resets neither D7 clock.
4. **Sleep:** a heartbeat arriving two hours after the prior one contributes
   at most the configured gap cap and does not immediately cross a threshold.
5. **Retry/race:** sending the same presence `event_id` twice, or a heartbeat
   for an observation that was replaced by navigation, changes no clock and
   starts no second Tier-2 review.
6. **Privacy and failure:** a blocked URL stores neither an observation body
   nor a content row; a missing content capture or either unavailable judge
   records a deferral and never invokes the current fallback nag.

### Implementation sequence

1. **Specify and test the pure policy first.** Add a `TimeBudgetConfig` (or a
   clearly named controller sub-config), validation for optional positive
   `available_time_minutes`, and a pure function for thresholds, interval
   accrual, and the predicate above.  Table-test no budget, normal budget,
   very short budget, page valve, OK reset in streak mode, no reset in
   alignment mode, exact threshold multiples, and a deferred review.
2. **Add additive SQLite migrations and store APIs.** Extend `goals`; add
   `drift_clock_states` and `observation_excerpts`; update record dataclasses,
   `get_current_session`, `set_current_goal`, session state, and the replay
   store shim in `apps/server/app/replay/core.py`.  Make a goal/budget change
   explicitly reset the new time state and event controller state, rather than
   carrying drift accumulated under a different declaration.
3. **Refactor server flow into three stages.** Keep Tier 0/Tier 1 and the
   existing event controllers for semantic eligibility; add idempotent
   presence/interval handling for clock advancement; then add a D7 review
   scheduler.  Move `on_intervened()`/`last_intervention_ts` to the branch
   where both Tier-2 results decide to notify.  Persist `review_observation_id`
   before issuing a review so concurrent heartbeat/nav requests cannot launch
   duplicate Tier 2 work.
4. **Capture bounded content for every qualifying observation.** Change the
   extension/API contract so capture occurs independently of
   `request_excerpt`.  Replace the old confirmation endpoint's raw-excerpt
   dependency with a read of stored content.  Update privacy/data-model docs
   and add retention, sensitive-domain, capture-failure, and payload-total-cap
   tests.
5. **Add presence relay in the extension.** Reuse `chrome.alarms` with a
   30–60-second D7 alarm, but retain immediate nav, tab activation, tab close,
   and window-focus signals to close/rebase a visit promptly.  On worker
   startup/alarm, query the focused window/active tab and re-establish presence
   rather than relying on `pendingTabObservations`.  Keep an event UUID in
   `chrome.storage.session` (or have the server issue a visit token) so retry
   after a fetch timeout cannot double-count an interval.
6. **Implement the dual judgment and UI/state exposure.** Extend payloads and
   provider parsing; run the two calls concurrently; record both decisions and
   the D7 deferral reason without raw excerpts in events.  Add an optional
   time field to popup setup/edit and show budget, selected clock, current
   page dwell, mode dwell, and “pending below per-page threshold” as a D7
   state distinct from an intervention pending delivery.
7. **Validate end-to-end and replay.** Add deterministic server tests using
   injected receipt times, extension tests/mocks for alarm and navigation
   races, migration tests from current databases, and replay support for
   presence/clock events.  Then run the required server suite and extension
   build before any implementation PR.

## 4. Risks, edge cases, and simpler alternatives

| Risk / edge case | Consequence | Required guard |
| --- | --- | --- |
| Sleep, wake, server outage, delayed alarm | Wall-clock subtraction can charge hours of absent reading. | Use server receipt times; cap accrual to heartbeat plus a small grace; rebaseline after a gap instead of backfilling it. |
| Tab/window focus changes | Chrome has an active tab per window; counting all active tabs overstates dwell. | Include `window_id`, follow the focused window, send immediate inactive/active events, and charge at most one session page at a time. |
| MV3 worker teardown or fetch retry | In-memory timers vanish; retry can double-charge a heartbeat. | Alarm-driven reconstruction plus unique presence-event IDs and an atomic server idempotency check. |
| Navigation/heartbeat race | A late heartbeat can accrue the wrong page or launch duplicate Tier 2. | Bind presence to server-issued observation/page identity, serialize updates per session, and persist one pending review. |
| Current 10-second versus documented 15-second start | Different clients/tests would start budgets at different moments. | Define clock origin as server final-verdict record time; remove `tier2_seconds` from D7 timing entirely. |
| Tier 2 deferral under current flow | It resets event eligibility and spends cooldown before a decision. | Separate candidate/review/notify transitions; begin delivery cooldown only after both judgments reject the side branch. |
| Provider failure or missing/capture-denied content | Current fallback can nag, creating the false positive D7 is meant to prevent. | Treat unavailable as a durable conservative deferral; expose the reason for diagnosis. |
| All-observation excerpt retention | D7 conflicts with current “never persist excerpts” promise and multiplies local sensitive data. | Explicit consent/documentation, server-side domain recheck, strict per-item and total payload caps, retention pruning, and no raw text in events/reports. |
| Very short/no budget and changing goals | Thresholds can be surprising; old drift can contaminate a new goal. | Fixed 15-minute no-budget fallback, min-total/per-page precedence tests, and reset D7/event state on declaration change. |
| Alignment hysteresis | Today's low latch does not rearm after `on_intervened`, so it cannot naturally produce repeated total-multiple reviews. | Preserve event eligibility separately from D7 review scheduling; do not use `armed` reset as the repeat-review mechanism. |

The simplest viable D7 implementation is **not** a row per 30-second tick.
Keep one durable clock state per session and add the bounded elapsed interval
only when an idempotent presence event arrives; retain only the recent `j`
excerpts needed for a review.  This meets server ownership, survives restarts,
and keeps storage proportional to observations rather than heartbeats.  A
client-only timer or a check added directly to `StreakController` would be
smaller, but both lose durability and cannot correctly implement alignment,
sleep handling, or next-multiple deferral.

## Review verdict

Proceed with D7 only after treating it as a small state-machine addition:
**classified page presence -> elapsed-clock accrual -> event eligibility ->
due review -> dual judgment -> deferred or delivered**.  The existing
relevance tiers and server ownership are good foundations.  The controller's
pre-Tier-2 state mutation, absent presence protocol, and changed excerpt
privacy contract are the three blockers to an otherwise clean incremental
implementation.

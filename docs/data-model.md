# Data Model

## Observation

```text
id
ts
session_id
source
payload
features
verdict
```

`observations.verdict` is the detector's original output and remains immutable
for replay and confusion-matrix auditing. When an observation has a `page_labels`
row, the label defines the product's effective verdict: `related` maps to `OK`
and `drift` maps to `DRIFT`. Current-page UI, session/report statistics, recent
judgment context, and anchor admission use that effective verdict.

For `browser_nav`, payload contains:

```json
{
  "url": "https://example.com/path",
  "title": "Example Title",
  "tab_id": 123
}
```

The server persists minimized URL metadata:

- host
- path hash
- no query string
- no fragment

## Goal

```text
raw_text
exemplars
provenance
available_time_minutes (optional)
```

Stage 0 supports only `provenance = "declared"`.

## SessionState

```text
goal
anchor
controller
obs_count
time_budget_clock
```

The anchor is the average of the latest effectively-OK observation embeddings.
DRIFT observations are never admitted. An explicit user `related` label is
eligible even when the detector's original anchor-admission flag was false.

## SQLite Tables

```text
sessions
goals
goal_exemplars
observations
page_labels
observation_requests
observation_processing_states
controller_states
drift_clock_states
drift_page_dwell_states
d7_prepared_reviews
observation_excerpts
dwell_presence_events
intervention_candidates
interventions
feedback
event_log
```

`observation_requests` is the durable browser-navigation idempotency ledger.
It stores only the opaque key, a hash of the canonical request, and the terminal
response JSON—never the raw URL or page body. A null response marks the active
claim. A completed row is replayed verbatim on transport retry; a key whose
request hash differs is rejected.

`observation_processing_states` is the current-goal-revision lookup used by
the popup while a browser navigation is being judged. It stores only minimized
page identity (`tab_id`, host, and path hash), title, and the active `tier0` or
`tier1` stage. Intake creates the row before Tier 0 work, advances it before a
Tier 1 provider call, and removes it when intake finishes or fails. Goal
revision changes remove older rows, and stale rows are pruned defensively.

`drift_clock_states` stores the active observation and page identity
(`url_host` + path hash), cumulative/continuous/current-page seconds, the next
review boundary, and a timestamped review lock. `drift_page_dwell_states`
retains the per-page dwell totals needed to survive tab flips within the
current episode. `dwell_presence_events` keeps presence event IDs only for
duplicate suppression. Both helper tables are pruned when the session ends.
`d7_prepared_reviews` stores at most one queued or prepared threshold-gated
Tier-2 outcome for the session: observation and goal revision, delivery
boundary, then the typed decision, optional generated message, and projected
review clocks once generation finishes. It remains protected
by the `drift_clock_states` review lock and is deleted on delivery, defer,
invalidation, clock reset, or session end.

## Interventions and Feedback

An intervention candidate is created when the controller requests a Tier 2
excerpt review. Creating the candidate does not reset streak/alignment evidence
or start the intervention cooldown. Only one `pending` or `in_flight` candidate
may exist per session.

```text
id
session_id
observation_id
status              pending | in_flight | confirmed | cancelled | expired
requested_at
expires_at
updated_at
intervention_id
result_json         terminal PipelineResult for confirmed/cancelled candidates
```

The pending lifetime includes the configured remaining Tier 2 dwell plus a
60-second resume grace period. Tier 2 cancellation leaves controller evidence
intact. Tier 2 confirmation consumes the evidence and links the candidate to a
new intervention. Candidate resolution, the Tier 2 result event, and the
terminal response are committed together; retrying a resolved candidate does
not call the judge or create another intervention.

An intervention is created only after Tier 2 confirms drift:

```text
id
session_id
observation_id
ts
message
status
```

Feedback is keyed by intervention and kind. The server treats repeated feedback for the same intervention/kind as a duplicate and does not repeat side effects.

```text
id
session_id
intervention_id
observation_id
kind
ts
```

Supported kinds:

- `related`: add the observation embedding to session goal exemplars, then mark the intervention `related`.
- `accepted`: mark the intervention `accepted`.
- `snooze`: set controller `snoozed_until`, then mark the intervention `snoozed`.

Goal exemplar cap enforcement preserves the declared-goal exemplar when possible and removes older feedback exemplars first.

Page labels are observation-scoped and do not require an intervention. A
`related` correction adds the observation embedding as an exemplar and resolves
an unhandled intervention for that observation. The streak controller clears its
accumulated streak. The alignment controller instead replaces only the latest
observation's relevance with `0.85`, recomputes `A_t`, and reapplies its
thresholds. The extension also updates the matching exploration-history verdict.
The original detector verdict is retained for audit.

## Raw Data Retention

When the D7 time-budget rule is enabled, each non-sensitive browser
observation may retain one normalized, character-limited page excerpt locally.
The store keeps only the current excerpt plus the configured recent context
window; older excerpts are pruned transactionally and excerpts are deleted on
both explicit and implicit session end. They are never copied into `event_log`,
reports, or feedback.
This enables the content half of D7's bounded Tier-2 comparison. With D7
disabled, excerpts remain transient as in the original pipeline.

Keystrokes are out of scope for Stage 0. If added later, raw keystroke text must never be written to disk.

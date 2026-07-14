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
keywords
exemplars
provenance
```

Stage 0 supports only `provenance = "declared"`.

## SessionState

```text
goal
anchor
controller
obs_count
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
controller_states
intervention_candidates
interventions
feedback
event_log
```

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
```

The pending lifetime includes the configured remaining Tier 2 dwell plus a
60-second resume grace period. Tier 2 cancellation leaves controller evidence
intact. Tier 2 confirmation consumes the evidence and links the candidate to a
new intervention.

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
`related` correction adds the observation embedding as an exemplar, clears
accumulated drift/controller state, and resolves an unhandled intervention for
that observation. The original detector verdict is retained for audit.

## Raw Data Retention

Page excerpts are transient. They are used for Tier 2 and then discarded.

Keystrokes are out of scope for Stage 0. If added later, raw keystroke text must never be written to disk.

# Architecture

## Components

```text
Chrome Extension
  background service worker
  content script for requested excerpts
  notification delivery and feedback

Local Server
  session state
  idle/active runtime mode
  observation pipeline
  provider orchestration
  controller state
  SQLite logs

External APIs
  Tier 1 cheap classifier
  Tier 2 context Judge and conditional persona Writer
```

## Server as SSOT

The server owns:

- active session
- declared goal
- exemplars
- OK anchor
- controller state
- event log
- intervention history

The extension owns no authoritative session state. It keeps only versioned,
short-lived dwell checkpoints in `chrome.storage.session`, paired with
`chrome.alarms`, so an MV3 service-worker restart cannot lose pending work.
Each navigation keeps the same idempotency key across retries; policy and
committed results remain server-owned.

## Runtime Modes

The local server is intended to be safe to start at login:

```text
idle    health/session APIs are available; judging resources are cold
active  a goal-backed session has initialized embeddings and judge providers
```

`GET /health` exposes the current mode. macOS uses a LaunchAgent to start the
idle server at login; Windows startup and tray status are implemented as a
platform adapter over the same endpoint.

## Observation Flow

```text
browser event
  -> extension dwell gate
  -> sensitive-domain pre-drop
  -> POST /observations/browser-nav
  -> normalize
  -> server privacy gate
  -> CPU embedding
  -> Tier 0 relevance
  -> optional Tier 1 classifier
  -> controller update
  -> time budget off: optional candidate + request_excerpt (controller evidence retained)
     -> combined Tier 2 Context Judge
     -> notify only: persona Message Writer
  -> time budget on: D7 bounded content capture + server-owned presence heartbeat
     -> optional combined time-budget Context Judge
     -> notify only: persona Message Writer
  -> confirmed drift consumes controller evidence
  -> notification
```

The Context Judge sees the current title/excerpt, compressed recent title
history, bounded recent excerpts, and D7 clock context in one call. It does not
receive persona or nagging instructions. A `defer` decision ends the review;
only `notify` invokes the plain-text Writer with title/host, time state, nagging
context, and the selected persona. Judge failures defer conservatively, while
Writer failures use the local persona fallback.

D7 navigation records do not activate a dwell clock by themselves. The
extension must assert an `active` presence for the focused, non-idle Chrome
tab; it sends `inactive` when Chrome loses OS focus or the user becomes
idle/locked. Heartbeats extend only the server-owned active clock, while a
later `active` event can safely recover it after tab/window changes or service
worker teardown.

## Extension-to-Server Actions

Server responses use explicit actions:

```json
{"action":"none","observation_id":"obs_..."}
```

```json
{"action":"request_excerpt","observation_id":"obs_...","candidate_id":"cand_..."}
```

```json
{"action":"notify","intervention_id":"int_...","message":"..."}
```

The extension should not infer policy from verdicts. It follows the action field.

## Replaceable Seams

- `EmbeddingProvider`
- `JudgeProvider`
- `MessageProvider`
- `Controller`
- `DeliveryAdapter`
- `SourceAdapter`

Stage 0 implements only the browser source and Chrome notification delivery.

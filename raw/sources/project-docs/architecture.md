# Architecture

## Components

```text
Chrome Extension
  background service worker
  content script for requested excerpts
  notification delivery and feedback

Local Server
  session state
  observation pipeline
  provider orchestration
  controller state
  SQLite logs

External APIs
  Tier 1 cheap classifier
  Tier 2 confirmation and message generation
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

The extension owns no durable state. This follows Chrome MV3 service-worker constraints and keeps replay deterministic.

## Observation Flow

```text
browser event
  -> extension debounce
  -> sensitive-domain pre-drop
  -> POST /observations/browser-nav
  -> normalize
  -> server privacy gate
  -> CPU embedding
  -> Tier 0 relevance
  -> optional Tier 1 classifier
  -> controller update
  -> optional request_excerpt
  -> Tier 2 confirmation/message
  -> notification
```

## Extension-to-Server Actions

Server responses use explicit actions:

```json
{"action":"none","observation_id":"obs_..."}
```

```json
{"action":"request_excerpt","observation_id":"obs_..."}
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


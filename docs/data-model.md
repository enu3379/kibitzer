# Data model

Status: serverless runtime after the 2026-07-24 cutover.

## Storage boundaries

Kibitzer uses two browser-local stores:

| Store | Durable data |
|---|---|
| `chrome.storage.local` | declared goal + epoch, user settings, persona, Ollama configuration, provider health, compact diagnostic log |
| IndexedDB `kibitzer` v3 | live runtime state, observations, structured events, and the durable effect outbox |

There is no SQLite database or server-side copy.

## Goal

```text
text
availableMinutes | null
startedAt
revision
epoch
```

`revision` changes within a goal's life. `epoch` is monotonic across
clear-and-redeclare cycles, so asynchronous Tier-2 work cannot mistake a new
goal for an older session with the same revision.

## Page identity

Runtime records do not persist a raw URL. For HTTP(S) pages, `pageKey` is:

```text
host + "#" + cyrb53(pathname + query)
```

Keeping the host supports repeat-host context. Hashing the path and query keeps
raw path data out of storage while distinguishing query-addressed pages such
as separate video IDs. This compact hash is a privacy minimization mechanism,
not a cryptographic commitment.

Titles may be retained in bounded recent context and event records. Sensitive
domains are rejected before observation.

## IndexedDB stores

### `kv`

Named runtime values, including:

- immersion-gauge checkpoint and Tier-2 request sequence;
- durable dwell candidate/checkpoint;
- pending Writer message and active-page state;
- learned exemplars, recency anchor, and derived goal phrases;
- bounded recent observation and nag context;
- presence/replay bookkeeping.

Reset operations update/delete related keys and clear record stores in one
transaction where atomicity matters.

### `outbox`

Auto-incremented effect records:

```text
id
ts
effect: request_tier2 | nag | celebrate
```

Gauge state and newly emitted effects commit atomically. Draining is
at-least-once: acknowledged effects are deleted; transient failures stay for a
later retry. Tier-2 work additionally carries a request ID, page key, and goal
epoch so superseded results are cancelled safely.

### `events`

Bounded structured audit/replay records:

```text
id
ts
type
data
```

Examples include goal changes, observation scores and verdicts, presence,
Tier-2 outcomes, delivery, feedback, and learned exemplars. The options page
can export these records as JSONL or clear them.

### `observations`

A bounded durable record store reserved for per-page observation/analysis
records. Current recent-title/nag context is kept in bounded `kv` entries.

## Gauge checkpoint

The checkpoint serializes the pure reducer state: `S`, momentum, acceleration
tier, active page/verdict, degraded margin, pending Tier-2 token, nag debt,
celebration state, snooze state, and update time. It is the source of truth for
recovery after MV3 service-worker teardown.

The trajectory anchor is disabled by default (`ANCHOR_WINDOW=0`), but learned
exemplars and guarded relevance state still live locally and are deleted by
the activity-data reset.

## Ollama payloads

Ollama is opt-in. Payload builders produce minimized, bounded shapes:

- Tier 1: goal, current title/host, and bounded recent titles/verdicts.
- Tier 2 Context Judge: goal, current title/host/verdict/score, bounded current
  excerpt, compressed recent titles, and compact time context.
- Tier 2 Message Writer: goal, title/host, the Judge decision, and compact
  time/nag context.

Raw URLs, IndexedDB rows, stored vectors, and the full event log are not
provider payloads.

## Delete and retention behavior

“Delete activity data” clears gauge/dwell/outbox state, observations, events,
logs, recent context, and learned vectors. It intentionally keeps the current
goal, Ollama configuration/key, persona, and user settings; the options UI
labels that distinction. Clearing or replacing a goal also resets the
goal-scoped runtime state.

The record stores are capped and recent context is bounded. Exact caps are
implementation constants in `apps/extension/src/lib/db.ts`,
`events.ts`, `history.ts`, and `klog.ts`.

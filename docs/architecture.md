# Architecture

Status: serverless runtime after the 2026-07-24 cutover. Historical server
designs remain available through `pre-serverless-cutover-2026-07-24`.

## Components

```text
Chrome MV3 extension
  popup + options UI
  background service worker
  active-page excerpt content script
  IndexedDB + chrome.storage.local
  packaged KoEn-E5 ONNX/WASM Tier 0
  optional Ollama Tier 1 / Tier 2
  in-page toast, badge, chime, and feedback
```

There is no local server, OS tray process, or HTTP state authority. The
extension service worker coordinates work but is disposable: durable state
lives in browser storage and pending work can recover after worker teardown.

## Authority and storage

The extension is the only runtime authority:

- `chrome.storage.local` owns the declared goal and its monotonic epoch,
  user settings, selected persona, provider health, and opt-in Ollama
  configuration.
- IndexedDB owns the gauge checkpoint, durable dwell checkpoint, pending
  effect outbox, learned relevance state, recent visit/nag context,
  observations, and the structured event log.
- The current page body is read only at the Tier-2 gate for the active,
  non-sensitive tab. It is bounded before an optional provider call and is not
  retained as a general browsing archive.

`docs/data-model.md` records the persistence boundary in more detail.

## Observation flow

```text
tab activation / settled navigation / title change
  → reject non-http(s), incognito, or sensitive-domain input
  → checkpoint a durable dwell candidate
  → verify page + goal epoch after dwell
  → Tier 0: packaged KoEn-E5 O4 embedding
  → optional Tier 1 rescue for a Tier-0 DRIFT
  → append observation context and update the immersion gauge
  → atomically checkpoint gauge state + enqueue effects
  → durable outbox drain
      request_tier2
        → revalidate active page + goal epoch
        → request a bounded active-page excerpt
        → optional Ollama Context Judge
        → optional persona Message Writer
        → revalidate the durable request token
        → feed result back into the gauge
      nag / celebrate
        → deliver toast, badge, chime, and record feedback context
```

A heartbeat integrates dwell only while Chrome is present and the tab is
eligible. Focus loss, idle/locked state, goal changes, or page changes cancel
or rebase pending work. Page and goal tokens prevent late asynchronous results
from acting on newer state.

## Durable-effect rule

The gauge reducer is pure and emits effect intents. Its new state and effects
commit in one IndexedDB transaction. An outbox record is deleted only after its
handler acknowledges it; Tier-2 work keeps a durable request token until the
final result is accepted or cancelled. This gives at-least-once recovery
without allowing a stale result to affect a different page or goal.

## Provider and privacy boundary

Tier 0 is offline. Ollama Cloud is disabled until the user supplies a key.
When enabled, minimized requests may include:

- the declared goal;
- current title and host;
- a bounded current-page excerpt at the Tier-2 gate;
- recent titles and verdicts;
- compact time and nag context.

Raw URLs, stored vectors, the full event log, and unbounded browsing history
are not sent. Sensitive domains are dropped before judging. See
`docs/privacy.md` for the complete contract.

## Replaceable seams

- Tier-0 embedding and Tier-1/2 judge providers
- pure gauge reducer and config
- durable store/outbox boundary
- dwell and presence schedulers
- page-excerpt adapter
- toast/badge/chime delivery
- persona prompt and fallback layer

The legacy Python implementations are reference material only; they are not a
second live authority.

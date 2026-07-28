# Privacy

## Principles

- Drop sensitive domains before dwell, embedding, provider calls, persistence,
  or delivery.
- Run Tier 0 locally with the packaged KoEn-E5 ONNX model.
- Read page body text only immediately before a possible Tier-2 intervention,
  from the active non-sensitive tab, and cap the cleaned excerpt at 3,000
  characters in the provider payload.
- Persist page identity as visible host plus a hash of path and query; never
  persist a raw path, query, or fragment.
- Keep Ollama Cloud disabled until the user supplies a key.

## Sensitive domains

`configs/sensitive_domains.json` is imported at build time by
`apps/extension-next/src/lib/domainFilter.ts`. The default rules cover banking,
payments, webmail, health, authentication, cloud-console secrets, and local
administration surfaces. The background worker drops a matching page before
judging and refuses to show a Kibitzer toast there.

## Ollama payload boundary

When Ollama Cloud is enabled, minimized requests may contain:

- the declared goal;
- current page title and host;
- recent page titles with their OK/DRIFT verdicts;
- a bounded current-page excerpt for Tier 2;
- current Tier-0 score/verdict and compact time/nag context.

They do not contain:

- a raw URL, path, query, or fragment;
- stored embedding vectors;
- the full IndexedDB event log;
- an unbounded browsing-history export;
- content from a sensitive-domain page.

The Tier-2 message writer receives the accepted judgment and compact nag/time
context, not the current excerpt. The options page repeats the network
disclosure next to the API-key field.

## Local storage and deletion

IndexedDB stores the goal-backed gauge state, durable dwell and outbox records,
observations, event log, learned exemplars, and recent visit/nag context.
Chrome local storage holds the declared goal/epoch, settings, persona, provider
health, and Ollama configuration.

**설정 → 모든 활동 데이터 삭제** removes gauge, observation, history,
learning, event, and nag activity. Goal, Ollama configuration, and persona are
intentionally retained and the UI states that boundary. Browser/profile
backups and storage-device snapshots are outside Kibitzer's deletion
guarantee.

## Incognito and failure behavior

The manifest sets `incognito: not_allowed`. Provider failures are recorded only
as coarse status categories; raw responses, request bodies, and API keys are
not written to activity logs. Tier 1 keeps the Tier-0 DRIFT verdict on failure;
Tier 2 fails open without a nudge.

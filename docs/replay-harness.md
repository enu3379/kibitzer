# Replay harness

Status: the serverless extension ships one pure replay engine used by both the
in-extension replay page and the offline Node CLI. The page can read browser
storage or an exported event log; the CLI reads the exported JSONL. Neither
path needs a server or an LLM.

## In-extension replay

Open **설정 → 데이터 → 리플레이 열기**. The page can read the extension's
current IndexedDB event log directly or load an exported JSONL file. It shows a
Tier-0 threshold sweep and a gauge chart for a selected threshold.

Use **설정 → 데이터 → 이벤트 JSON** to export the input log.

## Offline CLI

From `apps/extension`:

```sh
node --experimental-strip-types tools/replay.ts <events.jsonl> [availableMinutes]
```

The optional `availableMinutes` argument supplies the session time budget used
to derive the gauge configuration. When omitted, replay uses the no-budget
configuration.

The CLI reports:

- parsed event and scored-observation counts;
- a `tauOk` sweep from 0.45 through 0.75, including OK/DRIFT counts and flips
  from the recorded Tier-0 verdict (`0.59` is marked as the current default);
- an LLM-free degraded-mode gauge re-run at selected thresholds, with the
  resulting nudge count and S trajectory;
- recorded presence transitions, when available, so time away from Chrome does
  not drain the replayed gauge.

## Scope and limitations

Replay re-thresholds the numeric Tier-0 scores already present in `observe`
events. It does not re-run the embedding model, call Tier 1 or Tier 2, or
reconstruct the full exemplar/anchor/goal-enrichment and feedback-learning
timeline. The degraded-mode gauge result is therefore a counterfactual tuning
aid, not a byte-for-byte reproduction of every live decision.

The implementation is in `apps/extension/src/lib/replay.ts`; its contract
tests run as part of `npm test` and `npm run build`.

# Kibitzer docs

## Current product contracts

Read these first:

1. [Architecture](architecture.md)
2. [Data model](data-model.md)
3. [Privacy](privacy.md)
4. [ML providers](ml-providers.md)
5. [Platforms](platforms.md)
6. [Gauge contract](gauge/contract.md)
7. [Tier-0 O4 model and WASM parity](extension-onnx-model.md)
8. [Replay harness](replay-harness.md)

The active product is `apps/extension-next/`: one Chrome MV3 extension with no
local server. The directory name is retained for repository continuity; it is
not a second or experimental runtime.

## Active product and release work

- [Migration gap audit](migration-gap-analysis.md) — accepted post-cutover
  feature tails; completed rows are historical.
- [Chrome Web Store submission kit](store-submission.ko.md) — current beta
  submission copy and checklist.
- [Persona Workstream A](analysis-workstream-a-kyoto-baseball.md) and
  [Workstream B](research-workstream-b-persona-references.md) — active D15
  follow-up research until its product decisions land.

Current follow-up product work:

- #135 — judgment-review dashboard and verdict correction.
- #136 — Tier-0 OK audit routing.
- #141 — session pause, reports/history, and current-page verdict UI. Session
  end and its summary have landed.

The disposition and remaining B7/B8 tails are recorded in
[the migration gap audit](migration-gap-analysis.md) and D14 in
[planning notes](planning-notes.md).

## Decision records and evidence

These explain why the current product has its present shape; they are not
runtime or implementation instructions:

- [TypeScript/serverless migration record](ts-migration-plan.md)
- [Planning notes](planning-notes.md) — D-numbered decision history, including
  superseded server-era decisions.
- [Progress log](progress.md) — completed-work chronology.
- [Judgment audit plan](judgment-audit-plan.md) — pre-cutover problem analysis;
  use current issues and code for implementation status.
- [Persona voice revamp](persona-voice-revamp.md) and
  [persona benchmark evidence](benchmarks/persona-voice-v5/report.md).
- [Tier-2 prompt-injection red team](security-redteam-prompt-extraction.md) —
  historical threat-model and results; its documented Python harness is not in
  the active serverless tree.

## Historical plans and handoffs

Implementation plans, platform-daemon plans, pre-cutover analysis, and
`handoff-*.md` files describe completed or abandoned work against historical
snapshots. Do not treat their branches, paths, commands, or acceptance checks as
current unless a current issue explicitly reactivates and revalidates them.

The complete legacy runtime is preserved on `dev-legacy` and
`pre-serverless-cutover-2026-07-24`; the full pre-squash migration history is
preserved by `serverless-migration-head-2026-07-24`.

## Decision rule

When a design choice is ambiguous, prefer:

1. fewer false positives;
2. less raw-data retention;
3. a replaceable interface over premature feature breadth.

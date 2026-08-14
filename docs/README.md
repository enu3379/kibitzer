# Kibitzer docs

## Read before implementation

The active product is [`apps/extension/`](../apps/extension/): one Chrome MV3
extension with no local server or secondary runtime. Start with these current
product contracts:

1. [Architecture](architecture.md)
2. [Data model](data-model.md)
3. [Privacy](privacy.md)
4. [ML providers](ml-providers.md)
5. [Platforms](platforms.md)
6. [Gauge contract](gauge/contract.md)
7. [Tier-0 O4 model and WASM parity](extension-onnx-model.md)
8. [Replay harness](replay-harness.md)

## Active product and release work

- [Migration gap audit](migration-gap-analysis.md) records accepted
  post-cutover feature tails; completed rows are historical.
- [Chrome Web Store submission kit](store-submission.ko.md) contains the
  current beta submission copy and checklist.
- [Persona research](research/personas/) is active design evidence until its
  product decisions land.

Current follow-up product work and cutover disposition are recorded in the
[migration gap audit](migration-gap-analysis.md) and D14 in
[planning notes](planning-notes.md). The completed migration and rollback
references are in the [TypeScript/serverless migration record](ts-migration-plan.md).

## Research and supporting material

- [Gauge design rationale](research/gauge/analysis-plan-a-gauge-design.md)
- [Anchor experiments](research/anchor/)
- [Persona research](research/personas/)

## Decision records and evidence

These explain why the current product has its present shape; they are not
runtime or implementation instructions:

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

Completed handoffs, pre-cutover analyses, retired plans, and workflows are
preserved in [legacy/](legacy/). They are historical evidence unless a current
issue explicitly reactivates and revalidates them; their paths, commands, and
acceptance checks may refer to the retired Python server and relay extension.

## Decision rule

When a design choice is ambiguous, prefer:

1. fewer false positives;
2. less raw-data retention;
3. a replaceable interface over premature feature breadth.

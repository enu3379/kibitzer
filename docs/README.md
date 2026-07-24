# Kibitzer docs

## Current runtime

Read these first:

1. [Architecture](architecture.md)
2. [Data model](data-model.md)
3. [Privacy](privacy.md)
4. [ML providers](ml-providers.md)
5. [Platforms](platforms.md)
6. [TypeScript/serverless migration record](ts-migration-plan.md)
7. [Migration gap audit](migration-gap-analysis.md)
8. [Progress log](progress.md)
9. [Planning notes](planning-notes.md)

The active product is `apps/extension-next/`: one Chrome MV3 extension with no
local server. The directory name is retained for repository continuity; it is
not a second or experimental runtime.

## Runtime contracts and operations

- [Gauge contract](gauge/contract.md)
- [Tier-0 O4 model and WASM parity](extension-onnx-model.md)
- [Replay harness](replay-harness.md)
- [Judgment audit plan](judgment-audit-plan.md)
- [Persona voice revamp](persona-voice-revamp.md)
- [Security review](security-review-2026-07-15.md)
- [Tier-2 prompt-injection red team](security-redteam-prompt-extraction.md)

## Follow-up product work

The cutover does not claim complete UX/analysis parity:

- #135 — judgment-review dashboard and verdict correction.
- #136 — Tier-0 OK audit routing.
- #141 — session pause/end, reports/history, current-page verdict UI, and end
  summary.

The disposition and remaining B7/B8 tails are recorded in
[the migration gap audit](migration-gap-analysis.md) and D14 in
[planning notes](planning-notes.md).

## Historical plans and handoffs

Implementation plans, platform-daemon plans, pre-cutover analysis, and
`handoff-*.md` files are historical evidence unless a current issue explicitly
reactivates them. Their paths may refer to the retired Python server and relay
extension.

The complete legacy runtime is preserved on `dev-legacy` and
`pre-serverless-cutover-2026-07-24`; the full pre-squash migration history is
preserved by `serverless-migration-head-2026-07-24`.

## Decision rule

When a design choice is ambiguous, prefer:

1. fewer false positives;
2. less raw-data retention;
3. a replaceable interface over premature feature breadth.

# Kibitzer Docs

Read these in order when starting work:

1. [Kibitzer Implementation Guideline](kibitzer-implementation-guideline.md)
2. [2026-07-07 Alignment/Dwell Handoff](handoff-2026-07-07-alignment-dwell.md)
3. [Implementation Plan](implementation-plan.md)
4. [Architecture](architecture.md)
5. [Data Model](data-model.md)
6. [ML Providers](ml-providers.md)
7. [Privacy](privacy.md)
8. [Progress](progress.md)
9. [Replay Harness](replay-harness.md)
10. [LLM Wiki Integration](llm-wiki-integration.md)
11. [Judgment Audit Plan](judgment-audit-plan.md)
12. [Idle Daemon Plan](idle-daemon-plan.md)

## Stage Boundaries

Stage 0 implements browser navigation only. Keystrokes, agent prompts, inferred goals, dashboards, and permanent learning are intentionally out of scope.

## Decision Rule

When a design choice is ambiguous, prefer:

1. Fewer false positives.
2. Less raw data retention.
3. A replaceable interface over premature feature breadth.

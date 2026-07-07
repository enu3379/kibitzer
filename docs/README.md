# Kibitzer Docs

Read these in order when starting work:

1. [Kibitzer Implementation Guideline](kibitzer-implementation-guideline.md)
2. [Implementation Plan](implementation-plan.md)
3. [Architecture](architecture.md)
4. [Data Model](data-model.md)
5. [ML Providers](ml-providers.md)
6. [Privacy](privacy.md)
7. [Progress](progress.md)
8. [Replay Harness](replay-harness.md)
9. [LLM Wiki Integration](llm-wiki-integration.md)
10. [Judgment Audit Plan](judgment-audit-plan.md)

## Stage Boundaries

Stage 0 implements browser navigation only. Keystrokes, agent prompts, inferred goals, dashboards, and permanent learning are intentionally out of scope.

## Decision Rule

When a design choice is ambiguous, prefer:

1. Fewer false positives.
2. Less raw data retention.
3. A replaceable interface over premature feature breadth.

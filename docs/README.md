# Kibitzer Docs

Read these in order when starting work:

1. [Implementation Plan](implementation-plan.md)
2. [Architecture](architecture.md)
3. [Data Model](data-model.md)
4. [ML Providers](ml-providers.md)
5. [Privacy](privacy.md)
6. [Progress](progress.md)
7. [Replay Harness](replay-harness.md)
8. [LLM Wiki Integration](llm-wiki-integration.md)
9. [Judgment Audit Plan](judgment-audit-plan.md)

## Stage Boundaries

Stage 0 implements browser navigation only. Keystrokes, agent prompts, inferred goals, dashboards, and permanent learning are intentionally out of scope.

## Decision Rule

When a design choice is ambiguous, prefer:

1. Fewer false positives.
2. Less raw data retention.
3. A replaceable interface over premature feature breadth.

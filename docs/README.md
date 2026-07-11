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
13. [macOS Menu Bar Plan](macos-menu-bar-plan.md)
14. [Windows Idle Tray Plan](windows-idle-tray-plan.md)
15. [Platforms](platforms.md)
16. [Fun-Layer Roadmap](roadmap-fun-layer.md)
17. [Planning Notes (living decision log)](planning-notes.md)

Benchmarks:

- [Tier 0 Embedding Benchmark and Extension Contract](benchmarks/tier0-embedding/README.md)

Handoffs (delegated work specs):

- [P0 Persona Engine](handoff-p0-persona-engine.md)
- [P1 Attachment Loop](handoff-p1-attachment-loop.md)
- [P1 Claude Design Follow-up](handoff-p1-claude-design.md)
- [P2 Distribution](handoff-p2-distribution.md)
- [Extension Bundling](handoff-extension-bundling.md)

## Stage Boundaries

Stage 0 implements browser navigation only. Keystrokes, agent prompts, inferred goals, dashboards, and permanent learning are intentionally out of scope.

## Decision Rule

When a design choice is ambiguous, prefer:

1. Fewer false positives.
2. Less raw data retention.
3. A replaceable interface over premature feature breadth.

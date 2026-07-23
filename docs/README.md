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
- [Tier 0 Embedding v2 (real-corpus)](benchmarks/tier0-embedding-v2/report.md)
- [Persona Voice v4 (pre-split Tier 2 audit)](benchmarks/persona-voice-v4/report.md)
- [Persona Voice v5 (Judge/Writer split audit)](benchmarks/persona-voice-v5/report.md)

Design & security records:

- [Persona Voice Revamp](persona-voice-revamp.md)
- [Security Review 2026-07-15](security-review-2026-07-15.md)
- [Tier-2 Red-team: Prompt Extraction & Injection](security-redteam-prompt-extraction.md)

Handoffs (delegated work specs):

- [P0 Persona Engine](handoff-p0-persona-engine.md)
- [P1 Attachment Loop](handoff-p1-attachment-loop.md)
- [P1 Claude Design Follow-up](handoff-p1-claude-design.md)
- [P2 Distribution](handoff-p2-distribution.md)
- [Extension Bundling](handoff-extension-bundling.md)
- [Goal Enrichment](handoff-goal-enrichment.md)
- [Replay CLI](handoff-replay-cli.md)
- [D7 Review Findings](handoff-d7-review-findings.md)
- [Tier 2 Judge/Writer Split](handoff-tier2-judge-writer.md)
- [Pre-distribution Refactor Work Order](handoff-refactor-predist.md)
- [D9 Packaging Foundation](handoff-d9-packaging-foundation.md)
- [Windows pystray Lifecycle](handoff-windows-pystray-lifecycle.md)
- [Windows Launch Notifications (2026-07-18)](handoff-2026-07-18-windows-launch-notifications.md)
- [Provider Response Failures](handoff-provider-response-failures.md)
- [Popup Provider Failure Details](handoff-popup-provider-failure-details.md)

## Stage Boundaries

Stage 0 implements browser navigation only. Keystrokes, agent prompts, inferred goals, dashboards, and permanent learning are intentionally out of scope.

## Decision Rule

When a design choice is ambiguous, prefer:

1. Fewer false positives.
2. Less raw data retention.
3. A replaceable interface over premature feature breadth.

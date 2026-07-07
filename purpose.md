# Project Purpose

## Goal

Build Kibitzer: a local, non-blocking AI that observes browser navigation against a declared goal and comments only when drift accumulates.

## Key Questions

1. How do we minimize annoying false positives while still catching sustained drift?
2. Which parts must stay local for privacy and portability?
3. How should observations, verdicts, controller transitions, and feedback be logged for replay?
4. Does LLM Wiki help future implementation sessions recover project context quickly?

## Scope

In scope:

- Stage 0 browser navigation.
- Local CPU-only embedding.
- API-backed Tier 1 and Tier 2 judging.
- Chrome notification delivery.
- Replayable event logs.
- Documentation of implementation decisions.

Out of scope for Stage 0:

- Keystroke monitoring.
- Agent prompt monitoring.
- Inferred goals.
- Multiple simultaneous goals.
- Blocking interventions.
- Permanent learning across sessions.

## Thesis

Kibitzer should be useful only if it is quiet by default. Missing some drift is acceptable; repeated false positives are not.


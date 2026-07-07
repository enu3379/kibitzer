# Logging

Logs must be append-only and replayable.

Persist derived data needed for replay:

- observation metadata
- verdicts
- scores
- tier reached
- controller state transitions
- interventions
- feedback

Do not persist Tier 2 excerpts or future keystroke raw text.


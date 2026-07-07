# Replay Harness

Replay is required before tuning controller thresholds.

## Goal

Run the same event log through alternate configs:

```bash
kibitzer replay --session <id> --config configs/generous.yaml
kibitzer replay --session <id> --config configs/strict.yaml
```

## Output

Replay should report:

- observations processed
- verdict sequence
- intervention points
- changed intervention points versus baseline
- controller state transitions

## Non-goal

Replay does not re-call external APIs by default. It uses recorded verdicts unless explicitly asked to recompute tiers.

## Stage 0.5 Requirement

Before trying EWMA or Page-Hinkley, replay must support the same session log under the streak controller.


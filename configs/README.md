# Configs

All runtime knobs live here. Tuning must be a config change, not a code edit.

## Files

- `default.yaml` - portable Stage 0 defaults
- `sensitive_domains.yaml` - domain block/drop rules

## Calibration Warning

Embedding similarity thresholds are model-specific. If the embedding model changes, `tau_ok`, exemplars, anchor vectors, and replay baselines must be recalibrated.


# Configs

All runtime knobs live here. Tuning must be a config change, not a code edit.

## Files

- `default.yaml` - portable Stage 0 defaults
- `sensitive_domains.json` - shared server/extension domain block/drop rules
- `personas.yaml` - built-in persona voices and templates (user overrides merge
  from `~/.kibitzer/personas.yaml`)
- `experiment-models.example.yaml` - template for the gitignored
  `models.local.yaml` (tier model endpoints; keys stay in `.env`)

## Calibration Warning

Embedding similarity thresholds are model-specific. If the embedding model changes, `tau_ok`, exemplars, anchor vectors, and replay baselines must be recalibrated.

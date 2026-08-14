# Configs

All runtime knobs live here. Tuning must be a config change, not a code edit.

## Files

- `personas.yaml` + `personas/` - built-in persona voice data (voices, templates,
  order, and default). These are regenerated into the extension via
  `scripts/gen-personas.py`, which writes
  `apps/extension/src/lib/personas.data.ts`.
- `sensitive_domains.json` - domain block/drop rules imported at build time by the
  extension's domain filter (`apps/extension/src/lib/domainFilter.ts`).
  Editing it requires an extension rebuild for the change to take effect.

## Calibration Warning

Embedding similarity thresholds are model-specific. If the embedding model
changes, the Tier 0 `tau` in `apps/extension/src/lib/tier0.ts`, the relevance
floors in `apps/extension/src/lib/relevance.ts`, exemplars, and anchor
vectors must be recalibrated. The recalibration study lives in
`apps/extension/tools/anchorFloorStudy.ts`, with results recorded in
`docs/research/anchor/results-2026-07-24-anchor-floor-o4.md`.

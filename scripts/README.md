# Scripts

Project maintenance scripts live here.

## `gen-personas.py`

Regenerates `apps/extension/src/lib/personas.data.ts` from the persona
sources under `configs/`. It vendors `configs/personas/*.yaml` into the TS
module verbatim (no hand-copying) using `configs/personas.yaml` for the persona
order and default.

Run it after editing any `configs/personas*.yaml`:

```bash
python scripts/gen-personas.py
```

## `fixtures/`

Historical benchmark and smoke datasets: the Tier 0 embedding benchmark datasets
(v1/v2), guidelines, goal-enrichment simulation phrases, and the ONNX and Tier 2
smoke cases. Their Python runners were removed in the migration to the serverless
extension; the evidence snapshots produced from these datasets live under
`docs/benchmarks/`. The datasets are kept for reproducibility.

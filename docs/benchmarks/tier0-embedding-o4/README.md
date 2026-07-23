# Tier 0 embedding — O4 export tau_ok recalibration (2026-07-23)

Recalibration of the extension's TS Tier 0 threshold `tauOk` for the **O4 ONNX
export** (`onnx/model_O4.onnx`, sha256 `8dd4551d…`) now used by the WASM embedder,
which differs from the Python server's `model_qint8_arm64.onnx` that the original
`tau_ok = 0.6` was set for (see `docs/benchmarks/tier0-embedding-v2/`).

## Method

Same harness, dataset, and operating-point rule as v2 — only the model changed:

- `scripts/benchmark_tier0_embeddings.py --method onnx` over the 200-pair v2 dataset
  (`scripts/fixtures/tier0_embedding_benchmark_dataset_v2.json`), via the `onnx_cpu`
  provider pointed at `model_O4.onnx` + the shared tokenizer/prefix.
- Operating point = **FPR ≤ 10%** (the false-OK budget `tau_ok = 0.6` encoded on
  qint8, whose FPR-10% threshold was 0.5968 → rounded 0.6).
- **Harness validated:** re-running the qint8 model through this same setup
  reproduced the committed v2 FPR-10% threshold `0.5968325514548106` exactly, so the
  O4 number below is a true apples-to-apples comparison, not an environment artifact.

## Result

| Model | FPR-10% threshold | ROC/behavior |
|---|---|---|
| qint8_arm64 (Python server, committed v2) | **0.5968** | tau_ok = 0.6 |
| **O4 (TS runtime)** | **0.5869** | recalibrated |

The O4 export shifts the operating point by only ~0.01 (0.597 → 0.587) — O4 (graph
optimization) tracks the base model more closely than qint8 (int8 quantization), so
the two are near-identical at these thresholds. `operating_points.csv` (this dir) has
the full FPR sweep; `pair_scores.csv` has the per-pair O4 scores.

## Decision

Extension TS Tier 0 default `tauOk`: **0.6 → 0.59** (O4 FPR-10% = 0.5869, rounded to
two decimals; the v2 benchmark uses no cross-validation, so finer precision would be
false). Applied in `apps/extension/src/lib/providerShadow.ts`. The Python server keeps
`relevance.tau_ok = 0.6` (qint8) unchanged — it is removed at the Phase 5 cutover.

Being marginally lower than 0.6 also nudges toward the project's false-positive-first
principle (fewer false DRIFTs → fewer false nags).

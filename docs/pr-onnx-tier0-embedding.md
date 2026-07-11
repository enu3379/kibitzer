# PR Draft: Local ONNX Embeddings for Tier 0

**Target:** `dev`

**Suggested title:** `feat: use local ONNX embeddings for Tier 0`

## Summary

Replace Tier 0's shallow token-hash default with a local, CPU-only KoEn E5 Tiny
qint8 ONNX embedding. Keep the hash provider for deterministic tests and direct
benchmarking, and make fresh setup download and verify the required model files
automatically.

This follows the lightweight semantic-embedding investigation around
[PR #26](https://github.com/enu3379/kibitzer/pull/26), but avoids maintaining a
larger translated keyword list inside the bag-of-token hash approach.

## Changes

- Add an `onnx_cpu` provider using the model's original tokenizer,
  attention-mask-aware mean pooling, 384-dimensional L2-normalized vectors, and
  explicit CPU-only/runtime validation.
- Configure `exp-models/dragonkue-KoEn-E5-Tiny` qint8 ONNX as the Tier 0 default.
- Force single-item inference because this export showed batch-shape-dependent
  vectors on Windows x64.
- Add `onnxruntime` and `tokenizers` to the normal Python install.
- Add an idempotent model downloader with pinned sizes and SHA-256 hashes; call
  it from both platform setup scripts.
- Add an 8-case/40-text smoke report and a fixed 200-pair Korean/English
  benchmark that includes every prior smoke fixture pair.
- Make the benchmark method-agnostic: additional providers can be loaded with
  `--method name=module:factory`, with vector-shape/value/stability validation.
- Commit the full per-pair scores, operating-point tables, JSON result, and ROC
  plot under `docs/benchmarks/tier0-embedding/`.

## Benchmark

The benchmark treats `OK` as the positive class because Tier 0 is an
`obvious OK` filter. It uses no cross-validation. For each method and FPR budget,
the selected threshold maximizes recall subject to empirical FPR <= 5%, 10%,
15%, 20%, or 30%; ties prefer lower actual FPR and then a higher threshold.

| Method | ROC AUC | partial AUC at FPR <=30% | Average precision |
|---|---:|---:|---:|
| hash | 0.3680 | 0.0382 | 0.4013 |
| ONNX | 0.7199 | 0.3031 | 0.6043 |

At the <=5% FPR operating point, ONNX recalls 13.75% of labeled obvious-OK
pairs; hash recalls 1.25%. The corresponding ONNX threshold, `0.641367`, is the
provisional default. It remains a dataset-specific calibration aid, not an
estimate of unseen-data performance.

## Privacy And Runtime

- Tier 0 still receives only the declared goal/exemplars and normalized title.
- URL hosts and page bodies are not embedded.
- Setup downloads about 41 MB from the Apache-2.0 Hugging Face model repository.
- Inference is local and makes no API call.
- Model assets and the isolated ONNX test database remain under ignored `data/`.

## Test Plan

- [x] `python scripts/download_embedding_model.py --check`
- [x] `python scripts/smoke_onnx_embedding.py`
- [x] `python scripts/benchmark_tier0_embeddings.py`
- [x] External `--method candidate=module:factory` 200-pair run
- [x] `python -m pytest apps/server/tests -q` (121 passed)
- [x] `npm --prefix apps/extension run build`
- [ ] Run the macOS setup path and one real inference on macOS (reviewer follow-up)

## Checklist

- [x] PR title uses Conventional Commits format.
- [x] Server pytest passes on the final branch state.
- [x] Extension build passes on the final branch state.
- [x] AI-assisted.

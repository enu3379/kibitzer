# Embedding Providers

Tier 0 embeds only the declared goal/exemplars and the normalized page title.
It never embeds the URL host or page body. The resulting cosine score is used
as a high-precision `obvious OK` filter before any Tier 1 LLM review.

## Default: KoEn E5 Tiny ONNX

`onnx_cpu.OnnxCpuEmbeddingProvider` runs the quantized
[`exp-models/dragonkue-KoEn-E5-Tiny`](https://huggingface.co/exp-models/dragonkue-KoEn-E5-Tiny)
model locally with ONNX Runtime's `CPUExecutionProvider`.

- Model: `onnx/model_qint8_arm64.onnx` (38.3 MB, 384 dimensions)
- Tokenizer: the model's original `tokenizer.json` (2.9 MB)
- Pooling: attention-mask-aware mean pooling
- Input: whitespace-normalized text prefixed with `query: `
- Output: validated finite, non-zero, L2-normalized vectors
- Network use: setup download only; inference is fully local

`batch_size` is fixed to `1` in `configs/default.yaml`. This qint8 export
produced batch-shape-dependent vectors during Windows x64 testing, while
single-item inference made a text's vector independent of caller grouping.
Kibitzer normally embeds one title at a time, so this favors stable scores over
bulk benchmark throughput.

The provider fails explicitly if the model, tokenizer, dependency, shape, or
CPU-only invariant is wrong. It does not silently fall back to hash embeddings,
because changing the embedding space would invalidate the configured threshold
and stored vectors.

## Setup

The platform setup scripts install `onnxruntime` and `tokenizers`, then run:

```bash
python scripts/download_embedding_model.py
```

The downloader stores ignored assets under
`data/models/koen-e5-tiny-onnx/`, verifies pinned file sizes and SHA-256 hashes,
and is safe to rerun. Verify without network access with:

```bash
python scripts/download_embedding_model.py --check
```

## Hash Baseline

`hash_cpu.HashCpuEmbeddingProvider` remains available for deterministic unit
tests and the comparison benchmark. It is no longer the default runtime
provider.

See [the benchmark snapshot](../../../../../docs/benchmarks/tier0-embedding/report.md)
for the 200-pair hash-versus-ONNX results and per-pair scores.

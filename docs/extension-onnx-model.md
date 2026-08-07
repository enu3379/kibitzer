# Tier-0 ONNX model — KoEn E5 Tiny O4

Status: authoritative model record for the serverless extension.

## Selection

Kibitzer packages the upstream `onnx/model_O4.onnx` export from
`exp-models/dragonkue-KoEn-E5-Tiny`, pinned to revision
`961b7a2790353075d1819ad74852be9562550a2f`.

| Property | Value |
|---|---|
| Runtime | `onnxruntime-web/wasm`, CPU-only |
| Dimensions | 384 |
| Input | `query: ` prefix, 128-token maximum |
| Pooling | attention-mask mean pooling + L2 normalization |
| Model size | 74,893,112 bytes |
| Model SHA-256 | `8dd4551db5435efc2c3c724578569a8d6596df8f32447d1d109574c55b578234` |

The earlier Python runtime used an ARM64 qint8 export. Direct evaluation found
that export did not preserve its Python score space under ONNX Runtime Web and
was unsuitable for a cross-platform browser runtime. The O4 graph-optimized
fp32 export reproduced Python `CPUExecutionProvider` output over that same
export within `2e-4` for checked vector components and cosine.

## Distribution

The 74.9 MB model is intentionally git-ignored. Its pinned URL, size, digest,
license, tokenizer digests, and inference contract are recorded in:

```text
apps/extension-next/assets/models/koen-e5-tiny/model-manifest.json
```

`npm run build` begins with `scripts/checkProviderAssets.mjs`. If the model is
absent it downloads the immutable release asset, then verifies all model and
tokenizer sizes and SHA-256 digests plus the dependency-matched ONNX Runtime
WASM file. A mismatched or unavailable asset fails the build.

The verified assets are copied into `dist/assets/`; inference does not fetch a
remote model at runtime.

## Parity contract

`apps/extension-next/src/providers/tier0Wasm.test.ts` covers:

- deterministic tokenizer IDs and 128-token truncation;
- finite 384-dimensional normalized vectors;
- selected vector components and cosine against the Python-generated O4
  reference within `2e-4`;
- pooling and malformed-output guards.

These tests validate engine parity, not product calibration. The shipped O4
operating point is `tauOk=0.59`; the trajectory anchor is disabled by default
(`ANCHOR_WINDOW=0`). Calibration evidence is under
`docs/benchmarks/tier0-embedding-o4/` and
`docs/research/anchor/results-2026-07-24-anchor-floor-o4.md`.

## Provenance and recovery

`NOTICE.txt`, tokenizer files, and the manifest remain committed next to the
model location. The retired qint8/Python selection history is preserved by
`pre-serverless-cutover-2026-07-24`; it is not an active fallback.

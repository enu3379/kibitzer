# Extension ONNX Model — KoEn E5 Tiny for Tier 0 WASM

This documents which ONNX export of KoEn E5 Tiny the Chrome extension packages
for its TypeScript Tier 0 provider, why it is a *different* export than the one
the Python server runs, and how Python/WASM parity was verified.

The implementation lives on `migrate/ts-providers` (commit `78db50a`,
"feat: port providers to the TypeScript runtime", 2026-07-23 — Phase 4 of
[ts-migration-plan.md](ts-migration-plan.md)). That branch's merge is held on
the model-distribution decision described at the bottom, so this record lands
on `dev` independently to keep the selection rationale and test evidence
discoverable from mainline.

## Two exports of the same model

Upstream publishes three ONNX exports of
[`exp-models/dragonkue-KoEn-E5-Tiny`](https://huggingface.co/exp-models/dragonkue-KoEn-E5-Tiny)
(Apache-2.0): `onnx/model.onnx` (fp32, 150 MB), `onnx/model_O4.onnx`
(fp32, O4 graph-optimized, 74.9 MB), and `onnx/model_qint8_arm64.onnx`
(int8-quantized for ARM64, 38.3 MB). Kibitzer uses two of them:

| | Server (Python Tier 0) | Extension (TS Tier 0 shadow) |
|---|---|---|
| Export | `onnx/model_qint8_arm64.onnx` | `onnx/model_O4.onnx` |
| Runtime | ONNX Runtime `CPUExecutionProvider` | `onnxruntime-web/wasm` |
| Location | `data/models/koen-e5-tiny-onnx/` (git-ignored, fetched by `scripts/download_embedding_model.py`; introduced in PR #29) | `apps/extension/assets/models/koen-e5-tiny/model.onnx` (on `migrate/ts-providers`) |
| Size | 38,275,821 bytes | 74,893,112 bytes |

Both paths share the same inference contract: `query: ` prefix, 128-token
truncation, attention-masked mean pooling, L2 normalization, 384 dimensions,
CPU-only, no network call at inference time.

## Why the extension does not reuse the qint8 export

The obvious move — copying the server's already-downloaded
`model_qint8_arm64.onnx` into the extension — was tried first and rejected:

- **Direct testing showed different output under WASM.** The qint8 export's
  integer kernels did not preserve the Python score space when run in ONNX
  Runtime Web; vectors diverged from the Python `CPUExecutionProvider`
  reference rather than agreeing within tolerance.
- **The export is ARM64-targeted, the extension is not.** The extension's
  WASM provider must produce identical scores on every user machine. The same
  export already had a documented portability quirk server-side: it is
  batch-shape-sensitive on Windows x64, which is why `configs/default.yaml`
  pins `batch_size: 1`.

The O4 export is plain fp32 with graph-level optimizations only, so its WASM
output reproduces the Python reference within `2e-4` (below), at half the size
of the unoptimized fp32 export.

## Provenance

The packaged files are pinned to upstream revision
`961b7a2790353075d1819ad74852be9562550a2f` and recorded, with digests, in
`apps/extension/assets/models/koen-e5-tiny/model-manifest.json` and
`NOTICE.txt` on `migrate/ts-providers`:

| File | Source | SHA-256 | Size |
|---|---|---|---|
| `model.onnx` | `onnx/model_O4.onnx` | `8dd4551db5435efc2c3c724578569a8d6596df8f32447d1d109574c55b578234` | 74,893,112 |
| `tokenizer.json` | `tokenizer.json` | `a6dd38d692ac1caa6d5dbc195d92f1f978b5c74ec60e02ed15fdf04404742fe3` | 2,931,715 |
| `tokenizer_config.json` | derived | `a31cce3039d1c0610730707190f378fa2160f051c9172639fde71a41d2aaacf8` | 1,397 |

The extension never fetches model code or weights at runtime; the download
happens at packaging time only.

## Parity verification

`apps/extension/src/providers/tier0Wasm.test.ts` (committed alongside the
model on `migrate/ts-providers`) asserts parity against Python ONNX Runtime
`CPUExecutionProvider` running the *same* O4 export:

- **Tokenizer contract.** The browser tokenizer (`@huggingface/tokenizers`)
  must produce the exact token IDs of the Python `tokenizers` library — e.g.
  `query: 국내 여행지` → `[0, 37, 832, 12, 11804, 9339, 778, 2]` — including
  128-token truncation with a trailing EOS.
- **Vector parity.** WASM embeddings are 384-dimensional with L2 norm within
  `1e-6` of 1; leading components match Python reference values within
  `2e-4` per component.
- **Score-space parity.** cosine(`국내 여행지`, `서울 근교 당일치기`) must equal
  the Python reference `0.3421955704689026` within `2e-4`.
- **Pooling guards.** Mean pooling validates dimensions and rejects zero
  vectors.

The `2e-4` agreement means Tier 0 thresholds tuned against the Python provider
(e.g. `tau_ok`) remain meaningful for the WASM provider without re-tuning.

## Distribution status (open)

`model.onnx` is currently committed to `migrate/ts-providers` as a raw
74,893,112-byte git blob (`.gitattributes` marks `*.onnx binary`, which is not
LFS). Merging that history into `dev-migrate`/`dev` would bake the blob into
mainline forever, so the merge is **held** until the model is distributed
out-of-band: host the file as a GitHub Release asset under a non-version tag
(proposed: `model-koen-e5-tiny-o4`), pin the download URL and SHA-256, and
restore it at build time with a small fetch script (proposed:
`scripts/fetch-model.mjs`) when the asset is absent locally.

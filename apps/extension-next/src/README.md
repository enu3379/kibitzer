# Kibitzer serverless extension internals

This directory contains the authoritative TypeScript-only Kibitzer runtime. The former
FastAPI server and relay extension are preserved by the
`pre-serverless-cutover-2026-07-24` tag.

Core components:

- `src/core/gauge/` — the pure gauge reducer (`reduceGauge`) + fixtures test.
- `src/providers/` — TS Tier 0 (`WasmEmbeddingProvider`, ONNX/WASM, download-on-build model)
  and Tier 1/2 (`OllamaChatJudgeProvider`) + their tests (incl. the Python-parity check).

- `src/background.ts` — authoritative nav → Tier 0/1/2 → gauge → delivery pipeline.
- `src/lib/db.ts` / `gaugeRuntime.ts` — IndexedDB SSOT, durable outbox, and runtime wiring.
- `src/content/`, `src/offscreen.ts`, `src/popup/`, `src/options/` — browser surfaces.

There is no server client, port discovery, or shadow runtime.

## Build / test

`npm ci && npm run build` — `assets:check` fetches the ONNX model (download-on-build,
verified against `model-manifest.json`), then tests (gauge fixtures + provider parity) +
typechecks + esbuild bundle.

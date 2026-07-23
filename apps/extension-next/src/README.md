# kibitzer-extension-next (serverless)

The TypeScript-only, serverless Kibitzer extension, built in parallel with `apps/extension`
so the current product keeps working untouched until this one is validated. At cutover it
supersedes both `apps/extension` and `apps/server`, which are then deleted.

## Status: skeleton

Vendored, already-validated core (byte-identical to `apps/extension`, kept honest by the
shared `fixtures/gauge/`):

- `src/core/gauge/` — the pure gauge reducer (`reduceGauge`) + fixtures test.
- `src/providers/` — TS Tier 0 (`WasmEmbeddingProvider`, ONNX/WASM, download-on-build model)
  and Tier 1/2 (`OllamaChatJudgeProvider`) + their tests (incl. the Python-parity check).

Fresh here: `src/background.ts` (service-worker skeleton), `manifest.json`, `build.mjs`,
`package.json`. No server client, no port discovery, no shadow scaffolding.

## Next (follow-up PRs)

Authoritative pipeline in `background.ts`: nav → Tier 0 → Tier 1/2 → gauge (real trigger) →
notifications; IndexedDB SSOT + outbox (adapted from `gaugeIndexedDb`); content scripts
(readability, toast); offscreen audio; popup. Then dogfood, then cutover.

## Build / test

`npm ci && npm run build` — `assets:check` fetches the ONNX model (download-on-build,
verified against `model-manifest.json`), then tests (gauge fixtures + provider parity) +
typechecks + esbuild bundle.

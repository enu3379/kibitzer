# Platform strategy

Kibitzer has one runtime for macOS and Windows: the Chrome MV3 extension under
`apps/extension-next/`. There is no native server, tray, menu-bar process,
installer, or OS-specific launch agent in the active tree.

## Shared code

- `apps/extension-next/` — browser runtime, UI, tests, and build.
- `configs/` — persona sources and sensitive-domain rules.
- `fixtures/gauge/` — reducer contract fixtures.
- `docs/` — architecture, privacy, decisions, migration records, and evidence.

## Build matrix

GitHub Actions runs the same Node 22 contract on `macos-latest` and
`windows-latest`:

```sh
cd apps/extension-next
npm ci
npm run build
```

The build verifies model hashes, runs tests and both TypeScript checks, and
bundles `dist/`. Chrome 120 or newer loads that directory unpacked.

## Local-only state

Never commit API keys, browser profile data, IndexedDB exports, generated
`dist/`, downloaded `model.onnx`, `node_modules`, or local run logs. Ollama
keys live in Chrome local storage through the options UI.

The pre-migration native/server platform is historical and remains available
at `pre-serverless-cutover-2026-07-24`.

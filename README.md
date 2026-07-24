# Kibitzer

Kibitzer is a local, non-blocking attention guard. You declare a goal in the
toolbar popup, the extension watches your browser navigation, judges relevance
on-device, and only speaks up — a non-blocking in-page toast — when drift from
the declared goal accumulates. It never blocks browsing or typing.

Kibitzer is serverless: everything runs inside a single Chrome MV3 extension.
No local server, no cloud state. The only data that ever leaves the machine is
an explicit, opt-in judge call to Ollama Cloud when you supply an API key.
Those minimized requests may include the declared goal, the current page title
and host, a bounded current-page excerpt, recent page titles with their
verdicts, and compact time/nag context. Kibitzer never sends raw URLs, stored
vectors, the full event log, or an unbounded browsing-history export.

## Quick Start

Build the extension and load it unpacked:

```sh
cd apps/extension-next
npm ci          # install dev deps (esbuild, onnxruntime-web, typescript…)
npm run build   # fetch + hash-verify model, run tests + typecheck, bundle → dist/
```

Then in Chrome (≥ 120):

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `apps/extension-next/dist`.
3. Pin the Kibitzer icon, click it, and declare a goal (with an optional time
   budget). The gauge starts full and drains as you drift; a toast appears on
   the active tab once drift accumulates.

Without any API key the extension runs in on-device **Tier-0 mode**. Add an
Ollama Cloud key in the options page to enable the LLM judge and
persona-written nudges. See
[apps/extension-next/README.md](apps/extension-next/README.md) for the full
build, run, model-asset, privacy, and offline-replay details.

## Architecture

```text
Chrome events → Tier 0 (WASM embeddings) → immersion gauge
             → optional Tier 1/2 Ollama Cloud judge → non-blocking toast
```

- **Tier 0** embeds the page title/excerpt on-device with a KoEn-E5 embedding
  running under `onnxruntime-web` (WASM); embeddings never leave the machine.
- The **immersion gauge** is a pure-TS reducer that accumulates drift over time
  and decides when a nudge is warranted.
- **Tier 1/2** are optional Ollama Cloud judges (confirmation + message
  authoring), invoked only when a key is configured and only for a
  non-sensitive active tab.
- **Delivery** is an in-page toast on the active tab, redisplayed after tab
  switches while pending (system notifications only as a fallback).

**Browser-local storage is the authority.** `chrome.storage.local` owns the
declared goal and user/provider settings. IndexedDB owns the gauge, visit and
nag history, learned exemplars, durable Tier-2 job/effect outbox, dwell
checkpoint, and structured event log. This split lets an MV3 service worker be
torn down and revived without losing or double-applying work.

## Repository Layout

```text
apps/extension-next/  The product: the serverless Chrome MV3 extension
configs/              persona sources + sensitive_domains.json (privacy list)
fixtures/gauge/       language-neutral gauge contract fixtures
scripts/              gen-personas.py + historical benchmark fixture data
docs/                 design + decision history, migration plan, gauge contract
```

`configs/personas.yaml` + `configs/personas/*.yaml` are the source data for the
10 Korean personas; `scripts/gen-personas.py` regenerates
`apps/extension-next/src/lib/personas.data.ts`. `configs/sensitive_domains.json`
is imported directly by the extension's `src/lib/domainFilter.ts`.

## Implementation Defaults

```text
Embedding  KoEn-E5 Tiny O4 ONNX, on-device via onnxruntime-web (WASM)
Judges     Ollama Cloud (opt-in) — Tier-1 nemotron-3-super, Tier-2 minimax-m3
Storage    chrome.storage.local + IndexedDB (extension-local authority)
Runtime    TypeScript, Chrome MV3 only — no server, no other runtime
```

## Privacy

Kibitzer is local-first by design. Page body text is read only immediately
before a potential intervention, and only for the active, non-sensitive tab. A
sensitive-domain filter (banking, webmail, health, auth, localhost) drops those
pages before any judging and suppresses nudges there. All activity data stays in
the extension's IndexedDB and can be exported or wiped from the options page.
The single exception to on-device processing is the opt-in Ollama Cloud judge,
which receives the minimized context described above only after you enter a
key. The options page repeats this disclosure next to the key field.

## Status

The migration to a single serverless TypeScript extension is complete.
`apps/extension-next/` is the whole product; the former Python FastAPI server
and MV3 relay extension have been removed from the working tree. The
pre-migration code is preserved on the `dev-legacy` branch.
The unused LLM Wiki project integration and generated snapshots were retired
with the cutover; canonical documentation lives directly under `docs/`.
Immutable recovery points are also published as
`pre-serverless-cutover-2026-07-24` (legacy runtime) and
`serverless-migration-head-2026-07-24` (full migration history).

The trajectory anchor is disabled by default (`ANCHOR_WINDOW=0`), with
O4-recalibrated floors documented in
[docs/results-2026-07-24-anchor-floor-o4.md](docs/results-2026-07-24-anchor-floor-o4.md).
UX/analysis parity follow-ups remain tracked in
[#135](https://github.com/enu3379/kibitzer/issues/135),
[#136](https://github.com/enu3379/kibitzer/issues/136), and
[#141](https://github.com/enu3379/kibitzer/issues/141); they are not represented
as already implemented.
See [docs/progress.md](docs/progress.md) for the detailed log and
[docs/ts-migration-plan.md](docs/ts-migration-plan.md) for the migration plan.

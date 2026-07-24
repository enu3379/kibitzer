# Kibitzer (next) — serverless extension

A local, non-blocking attention guard, packaged as a **single Chrome MV3 extension** with
**no local server**. You declare a goal in the toolbar popup; the extension watches your
browsing, judges relevance on-device (a local KoEn-E5 embedding + optional Ollama Cloud
judges), and only speaks up — a non-blocking in-page toast — when drift from the goal
accumulates.

This is the serverless successor to the former Python server + relay extension. It runs
entirely in the browser: all session state, history, learning, and the event log live in
the extension's own IndexedDB. The cutover is complete — this is the product; the legacy
apps have been removed from the working tree and are preserved on the `dev-legacy` branch.

## Prerequisites

- **Node.js ≥ 22.6** — the build/test scripts use `node --experimental-strip-types`.
- **Google Chrome ≥ 120** (MV3 offscreen documents, service-worker modules).
- Network access **once** at build time to fetch the embedding model (see [Model assets](#model-assets)).

## Build

```sh
cd apps/extension-next
npm ci          # install dev deps (esbuild, onnxruntime-web, typescript…)
npm run build   # verify assets → run tests + typecheck → bundle into dist/
```

`npm run build` is self-checking: it fetches and hash-verifies the model assets, runs the
test suite and both typechecks, then bundles everything into `dist/`. A green build leaves
a complete, loadable extension in `apps/extension-next/dist/`.

For iterative work: `npm run watch` (rebuilds on change; run `npm test` separately).

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`apps/extension-next/dist`** folder.
4. Pin the Kibitzer icon to the toolbar.

To pick up a rebuild, click the extension's **↻ reload** button on `chrome://extensions`.

## First run

1. Click the toolbar icon → **declare a goal** (e.g. `논문 정리`) and, optionally, a time
   budget in minutes. The gauge starts full and drains as you drift.
2. Keep browsing. When drift accumulates on off-goal pages, a toast appears on the active
   tab. Each toast offers **"목표와 관련 있어요"** (teaches relevance — recovers the gauge and
   remembers the page) and **"5분"** (snooze).
3. Open **설정** (the options page) to tune sensitivity, quiet hours, voice read-out,
   persona (nudge tone), the AI judge, and data controls.

Without any AI key the extension still works in **Tier-0 mode** (on-device title/excerpt
similarity only). Add keys to get the LLM judge + persona-written nudges:

- In **설정 → AI 판정 · Ollama Cloud**, paste one or more [ollama.com](https://ollama.com)
  API keys (one per line — multiple keys auto-rotate). Defaults: Tier-1
  `nemotron-3-super`, Tier-2 `minimax-m3`. Use **연결 테스트** to confirm.

## Model assets

The 74 MB embedding model (`assets/models/koen-e5-tiny/model.onnx`) is **not committed**.
`npm run build` downloads it from a pinned GitHub Release and verifies size + SHA-256
against `assets/models/koen-e5-tiny/model-manifest.json` before bundling, so a fresh clone
builds reproducibly. The small tokenizer files are committed. Everything runs on-device via
`onnxruntime-web` (WASM); embeddings never leave the machine.

## Data & privacy

- All state (gauge, visit/nag history, learned exemplars, structured event log) lives in
  the extension's local **IndexedDB** — nothing is sent to any server.
- A sensitive-domain filter (banking, webmail, health, auth, localhost) drops those pages
  before any judging and suppresses nudges there.
- Page body text is read only immediately before a potential intervention, and only for
  the active, non-sensitive tab.
- **설정 → 데이터** exports the debug log / event log (JSONL) and wipes all activity data.

## Offline tuning (replay)

The structured event log can be replayed offline to tune detection without live
trial-and-error:

```sh
node --experimental-strip-types tools/replay.ts <events.jsonl> [availableMinutes]
```

It prints a `tau` sweep (OK/DRIFT/flips per threshold) and a gauge re-run (nudge count +
S sparkline per threshold). The same engine backs the in-extension replay page (opened from
**설정 → 리플레이 열기**), which can read IndexedDB directly or an uploaded JSONL.

## Layout

```text
manifest.json         MV3 manifest (popup, options, background SW, offscreen)
build.mjs             esbuild bundler + static-file copy
src/
  background.ts       service worker: observe → judge → dispatch → deliver
  popup/              toolbar popup (goal + gauge)
  options/            settings page (sensitivity, quiet hours, TTS, persona, AI, data)
  replay/             in-extension replay page
  offscreen.ts        audio chime + Web Speech TTS (autoplay-safe)
  content/            page-excerpt extraction (injected)
  lib/                gauge, relevance, tier0/1/2, personas, db, events, settings…
  providers/          Ollama Cloud chat client
assets/models/        KoEn-E5 tokenizer (committed) + model.onnx (fetched at build)
tools/replay.ts       Node CLI replay
dist/                 build output — this is what you load unpacked (git-ignored)
```

## Status

Cutover is complete: this extension is the product, and the legacy server + relay
extension have been deleted from the working tree (preserved on `dev-legacy`). The pure
decision core (gauge reducer/config, Tier-1/2 prompts, KoEn-E5 model, personas) is ported
byte-parity, the P0–P3 wiring in `docs/migration-gap-analysis.md` landed, and the
release-blocking behavioural gaps from the 2026-07-24 runtime audit (B1–B6/B9) are fixed
and merged: a durable effect outbox and persistent dwell timer for MV3 worker-teardown
recovery, verdict-generation guards against stale-page races, a hashed page key, a
complete delete-all, and an `incognito` guard. The trajectory anchor is disabled by
default (`ANCHOR_WINDOW=0`) with O4-recalibrated floors
(`docs/results-2026-07-24-anchor-floor-o4.md`), and an E2E background test now covers the
observe→judge→deliver loop.

Remaining follow-ups are tracked as issues rather than blockers:

- **#135** — port the judgment-review dashboard.
- **#136** — port the Tier-0 OK audit routing.
- B7/B8 tails from `docs/migration-gap-analysis.md`.

# Agent Guide — Kibitzer

Kibitzer is a local, non-blocking attention guard: the user declares a goal, the extension observes Chrome navigation, and it comments only when drift accumulates (gauge-driven attention guard). It is a single serverless TypeScript Chrome MV3 extension — the extension **is** the product; there is no server. All session state, scoring, and LLM calls (Ollama) run inside the extension service worker.

Full collaboration rules: [CONTRIBUTING.md](CONTRIBUTING.md) (Korean). Strategic decision log: [docs/planning-notes.md](docs/planning-notes.md) (D-numbered decisions). Work orders for agents live in `docs/handoff-*.md`.

## Commands

Extension (run from `apps/extension-next`):

```sh
cd apps/extension-next
npm ci
npm run build      # assets hash-verify → test suite → tsc --noEmit ×2 → esbuild → dist/
npm test           # tests + typecheck only
npm run watch      # rebuild on change
```

Node ≥ 22.6 required (`--experimental-strip-types`). Replay CLI: `node --experimental-strip-types tools/replay.ts <events.jsonl>`.

Regenerate personas after editing `configs/personas*.yaml`:

```sh
python scripts/gen-personas.py   # → apps/extension-next/src/lib/personas.data.ts
```

## Layout

- `apps/extension-next/` — the whole product: Chrome MV3 extension (TypeScript, esbuild). Internals map: `apps/extension-next/src/README.md`
- `configs/` — personas YAML sources + `sensitive_domains.json` (imported by `src/lib/domainFilter.ts`)
- `fixtures/gauge/` — shared reducer contract fixtures used by extension-next tests
- `docs/` — design docs, planning notes, handoff docs, progress log
- `scripts/` — `gen-personas.py` + historical benchmark fixture data
- `tools/store-shot/` — headless-Chrome rig that re-renders the Chrome Web Store screenshots and promo images into `docs/screenshots/`

## Workflow rules (operational minimum)

1. Never commit directly to `main` or `dev` — rulesets reject direct pushes.
2. Branch from `dev`: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `codex/<slug>`. Only `hotfix/<slug>` branches from `main` (and must merge into both `main` and `dev`).
3. Open PRs against `dev`. It is squash-merged: **the PR title becomes the commit message**, so PR titles must follow Conventional Commits (`feat: …`, `fix: …`, `chore: …`).
4. Run `apps/extension-next`'s `npm run build` before opening a PR. CI (macOS + Windows, Node 22) must pass to merge.
5. Check the **AI-assisted** box in the PR template.
6. Never commit secrets. Ollama keys/endpoints live in the extension options UI now (there is no `.env`).

`dev-legacy` is the frozen pre-migration snapshot (read-only reference — never merge it forward).
`pre-serverless-cutover-2026-07-24` preserves that exact tree, while
`serverless-migration-head-2026-07-24` preserves the full pre-squash migration
history. The `dev-migrate` integration branch is retired.

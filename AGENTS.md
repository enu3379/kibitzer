# Agent Guide — Kibitzer

Kibitzer is a local, non-blocking attention guard: the user declares a goal, the system observes Chrome navigation, and it comments only when drift accumulates. Python FastAPI server + Chrome MV3 extension. The server is the single source of truth for session state; the extension service worker is only an event relay.

Full collaboration rules: [CONTRIBUTING.md](CONTRIBUTING.md) (Korean). Strategic decision log: [docs/planning-notes.md](docs/planning-notes.md) (D-numbered decisions). Work orders for agents live in `docs/handoff-*.md`.

## Commands

Server (run from repo root):

```sh
python -m pip install -e ".[test]"     # install with test deps
python -m pytest apps/server/tests -q  # server tests
```

Extension:

```sh
cd apps/extension
npm ci
npm run build      # tsc --noEmit + esbuild → bundles
npm run watch      # rebuild on change
```

Platform setup guides: [MACOS_SETUP.md](MACOS_SETUP.md), [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

## Layout

- `apps/server/` — Python FastAPI local server (`app/api`, `app/core`, `app/providers`, `app/storage`; tests in `apps/server/tests`)
- `apps/extension/` — Chrome MV3 extension (TypeScript, esbuild)
- `configs/` — runtime knobs and privacy lists (`configs/models.local.yaml` is local-only, git-ignored)
- `docs/` — design docs, planning notes, handoff docs, progress log
- `data/` — local runtime data, git-ignored
- `scripts/` — platform setup, run, smoke, maintenance

## Workflow rules (operational minimum)

1. Never commit directly to `main` or `dev` — rulesets reject direct pushes.
2. Branch from `dev`: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`, `codex/<slug>`. Only `hotfix/<slug>` branches from `main` (and must merge into both `main` and `dev`).
3. Open PRs against `dev`. It is squash-merged: **the PR title becomes the commit message**, so PR titles must follow Conventional Commits (`feat: …`, `fix: …`, `chore: …`).
4. Run `python -m pytest apps/server/tests -q` and `apps/extension`'s `npm run build` before opening a PR. CI (macOS + Windows) must pass to merge.
5. Check the **AI-assisted** box in the PR template.
6. Never commit secrets: `.env` and `configs/models.local.yaml` stay local.

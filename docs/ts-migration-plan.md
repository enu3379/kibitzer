# Kibitzer TypeScript/serverless migration

Status: **v1.0, cutover complete, 2026-07-24.** This is the canonical record of
the migration from the Python FastAPI server plus MV3 relay extension to one
TypeScript Chrome extension. The scope decision is recorded in
`docs/planning-notes.md` D14.

## 1. Final architecture

```text
Chrome events → Tier 0 (KoEn-E5 WASM) → optional Tier 1 (Ollama)
              → immersion gauge → optional Tier 2 (Ollama) → toast
```

- `apps/extension/` is the only runtime.
- `chrome.storage.local` owns the goal and settings. IndexedDB owns the gauge
  state, durable dwell checkpoint, effect outbox, recent context, learned
  exemplars, and structured event log.
- The Python server, relay extension, menubar/tray apps, packaging, and
  platform launch scripts are no longer in the active tree.
- Ollama Cloud is opt-in. Its minimized payload disclosure is documented in
  the root README, extension README, and options UI.

## 2. Preservation and rollback

The cutover is forward-only on `dev`, but both sides of the boundary remain
addressable:

| Reference | Commit | Purpose |
|---|---|---|
| `dev-legacy` | `f8be749` | Read-only pre-migration branch |
| `pre-serverless-cutover-2026-07-24` | `f8be749` | Immutable legacy-runtime recovery point |
| `serverless-migration-head-2026-07-24` | `4303e1e` | Full 92-commit migration history before squash |
| PR #138 squash | `59307a0` | Serverless runtime integrated into `dev` |

The original #139 head is additionally preserved by
`pr139-before-rebuild-2026-07-24`. Revert a bad cutover on `dev`; never
forward-merge `dev-legacy`.

## 3. Completed phases

1. **Pure gauge core.** A deterministic TypeScript reducer was checked against
   shared language-neutral fixtures and the temporary Python reference.
2. **Durable browser state.** IndexedDB became the SSOT for checkpoints and
   pending effects.
3. **Providers.** KoEn-E5 O4 ONNX/WASM, Ollama Tier 1/2, minimized payloads,
   parsers, prompts, and key rotation moved into the extension.
4. **Authoritative pipeline.** Browser navigation, presence, dwell, Tier 0/1/2,
   gauge transitions, feedback, and delivery were wired in
   `apps/extension`.
5. **Runtime hardening.** The cutover audit closed the durable outbox,
   stale-verdict, persistent-dwell, hashed-page-key, incognito/delete-all, and
   S=0 recovery blockers. Background integration tests cover the
   observe→judge→deliver path.
6. **Repository cutover.** PR #138 integrated the runtime. PR #139 removed the
   legacy tree and aligned active docs, scripts, CI, and contributor guidance.

## 4. Shipped calibration

- The O4/WASM Tier-0 operating point is `tauOk=0.59`.
- The trajectory anchor is disabled by default (`ANCHOR_WINDOW=0`).
- Dormant anchor reactivation guards use the O4-recalibrated `0.50` floor.
- Evidence is preserved under `docs/benchmarks/tier0-embedding-o4/` and
  `docs/research/anchor/results-2026-07-24-anchor-floor-o4.md`.

## 5. Accepted follow-ups

These are explicit post-cutover product/analysis work, not hidden claims of
runtime parity:

- #135 — judgment-review dashboard and verdict correction.
- #136 — Tier-0 OK audit routing and title-quality gate.
- #141 — session pause/end, reports/history, current-page verdict card, and
  end-summary parity.
- B7/B8 tails in `docs/migration-gap-analysis.md` — full learning-aware replay
  and additional persisted provider context.

The correctness/privacy deletion gates were B1–B5 and B9. B6–B8/B10 are
tracked UX/analysis/context follow-ups under D14.

## 6. Branch model after cutover

- `dev` is again the integration branch; feature/fix/chore/codex branches start
  there and are squash-merged.
- `dev-migrate` is retired. Its full history remains reachable through
  `serverless-migration-head-2026-07-24`.
- `dev-legacy` is read-only and must never be merged forward.
- Stable `dev` snapshots are promoted to `main` by merge commit.

## 7. Verification contract

From `apps/extension`:

```sh
npm ci
npm run build
```

The build hash-verifies model assets, runs the Node test suite and two
TypeScript checks, then bundles the loadable extension. CI runs this contract
on macOS and Windows with Node 22.

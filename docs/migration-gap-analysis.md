# Migration Gap Analysis — original → `extension-next`

_Generated 2026-07-24 from a 6-way subagent sweep of `apps/server/` + `apps/extension/` (ORIGINAL) vs `apps/extension-next/` (NEW serverless target)._

**Framing:** The pure decision core carried over cleanly — the gauge reducer/config (`core/gauge/*`) is **byte-identical**, and the Tier-1/2 prompts, judge→writer split, key-pool rotation, KoEn-E5 ONNX model, and the 10 personas are all faithfully ported. **Every gap below is in the wiring _around_ that core**: the observation surface, the LLM/Tier-0 _inputs_, durable storage, corrective feedback, privacy, and the user-facing surfaces. Nothing here is a reducer bug.

Legend — Effort: S(mall)/M(edium)/L(arge). "Blocked on SSOT" = needs the durable IndexedDB store (P2-1) first.

---

## ⚠️ Cutover blockers — 2026-07-24 runtime audit

A behavioural audit of `fix/extension-next-wasm-csp` (independent of the P0–P3 sweep below) found defects that a green build does **not** catch. **These block deleting `apps/extension` / `apps/server`.** The P0–P3 tables that follow track feature *presence*; this table tracks behavioural *equivalence*. Fix in the recommended order (top-down).

| # | Sev | Defect | Anchor |
|---|-----|--------|--------|
| B1 | Blocker | ✅ **CLOSED** (`atomic effect outbox` → `closure-v2/v3/v4`; Tier-2/identity lens came back **CLEAN** on adversarial re-review). Durable Tier-2 job (single-flight, ACK only after durable reflection/stale-cancel, teardown→retry). Identity = opaque monotonic **`requestId`** carried **per-effect** and **preserved across resetState** (never reused; guarded `Number.isFinite`). Apply requires matching requestId + goal `epoch`. Writer text durable + dropped in the outbox tx + cleared if unconsumed; resetState serialized + one-tx; **DB v3 migration surgical** (releases wedge, preserves gauge); `setGoal` epoch serialized. _Reducer/types diverge from Python core (`tier2ReqSeq`/`requestId`/`tier2_cancel`) — intended._ 3-lens adversarial self-review REFUTED all suspicions (per-effect requestId, migration reuse, deadlock, double-ACK) with repros. | `src/core/gauge/*`, `src/lib/gaugeRuntime.ts`, `src/lib/tier2Token.ts`, `src/lib/session.ts`, `src/lib/db.ts` |
| B2 | Blocker | ✅ **CLOSED** (closure-v5 + **v6**). `judgeAndDispatch` re-checks after its awaits, before any mutation, that the **active tab is still the judged page AND the goal epoch is unchanged** (`stillJudging`); else drops the verdict. v4 `serializeJudge` removed (stale-drop subsumes it, no head-of-line block). **v6:** re-review found the drop left the debounce marker (`lastObservedKey`) on the never-judged page, so it was never re-judged on return — now cleared on drop; and the removed serialization's concurrent-RMW loss (recent-titles/anchor/exemplar) is closed via an atomic `kvUpdate`. | `src/background.ts`, `src/lib/{relevance,history,gaugeRuntime,db}.ts` |
| B3 | Blocker | ✅ **CLOSED** (`durable dwell timer` + closure-v2 + `closure-v4`) — `DwellScheduler`: checkpoint deleted only after a successful judge, via CAS; reconcile single-flight; idle / focus-loss / goal-change cancel; a new candidate atomically replaces the checkpoint. **closure-v4:** same-path title churn (notification counters) no longer keeps pushing the deadline out — the page still gets judged (deadline preserved per path). fake-indexeddb tests: restart-restore, stale-cancel, mid-judge retry, duplicate single-flight, CAS-no-clobber, atomic-replace, deadline-preserved-across-churn. **Test caveat:** extracted-unit tests against real IndexedDB, not a full `background.ts` chrome-mock E2E harness (deferred to B4/B5 → cutover). | `src/lib/dwellScheduler.ts`, `src/background.ts` |
| B4 | Blocker | ✅ **CLOSED** (B4 commit). `pageKeyOf` now returns `${host}#${cyrb53(pathname+search)}` — the query is folded in (no more `?v=A`/`?v=B` collision) and the raw path is never persisted (host stays visible). Dwell deadline-preservation restored to pageKey-based (SPA content now distinct → no under-dwell; same-URL title churn absorbed). _cyrb53 is synchronous; crypto-grade SHA-256 would need an async pageKeyOf — noted as a follow-up._ Tests: query-distinct, path-hashed, non-http null; dwell churn-vs-SPA. | `src/lib/url.ts`, `src/lib/dwellScheduler.ts` |
| B5 | Blocker | ✅ **CLOSED** (B5 commit). Manifest now has `incognito: not_allowed`. delete-all already clears learned vectors (resetState→clearRelevance) + history + events + observations; goal/keys/persona retention is intentional and labeled in the options UI. | `manifest.json`, `src/background.ts` |
| B6 | High | 🟡 **Mostly closed** (B6 commit). Durable display token in the SSOT (no more SW-restart id reuse → markNagActed acts on the right nag); OS-notification buttons carry the `displayToken`; body-click "accepted" is handled by the generic feedback path. **Remaining (UI parity, not correctness):** an explicit current-page verdict card / DRIFT label / pending-intervention surface in the popup. | `src/lib/gaugeRuntime.ts`, `src/background.ts` |
| B7 | High | 🟡 **Mostly closed** (B7 commit). Replay is now **presence-aware**: the runtime logs sparse active↔inactive transitions; `replayGauge` treats an away minute as an inactive rebase (no drain), so a 39-min AFK stretch no longer replays as active drift. Old logs fall back to assume-present. **Remaining (lower value):** replay still doesn't re-run exemplar/anchor/enrichment learning or the feedback timeline — it re-thresholds recorded scores (a tuning approximation, documented). | `src/lib/replay.ts`, `src/background.ts` |
| B8 | High | 🟡 **Mostly closed** (B8 commit). Tier-1 rescue now receives the recent-visit titles; Tier-2 reports `tier_reached=1` (reaching the gate implies Tier-1 ran) instead of a hardcoded 0. **Remaining (needs extra persistence/privacy call):** the cross-lingual derived-phrase TEXT and recent-PAGE-content aren't stored, so those two payload fields stay empty. | `src/lib/tier12.ts`, `src/background.ts` |
| B9 | High | ✅ **CLOSED** (B9 + **closure-v6**). Negative/0/non-finite time budget rejected at three layers (tBudgetSeconds fallback + popup + set-goal). Snooze-suppressed S=0 recovery: **v6** — re-review found the first attempt stormed `request_tier2` under navigation churn (each request resolved stale → `tier2_cancel` re-armed the gate, unbounded, never nudging); the recovery now **nudges directly** (S=0 = confirmed drift), sets nagN=1 (fires once), and lets debt-renag take over. Tests: direct-nag / no-storm. | `src/core/gauge/{config,reducer}.ts`, `src/popup/popup.ts`, `src/background.ts` |
| B10 | High | **Session UX missing** — end/pause/end-summary, daily & session reports, navigation history, and verdict correction are unimplemented (this doc's P3-3/P3-8 concede "next"). | `docs/migration-gap-analysis.md` P3-3 |

Not equivalent yet but lower priority: SEO title-suffix strip (P3-2), custom persona, independent Tier-1/Tier-2 provider config, cooldown/dwell settings. **Confirmed intentional** architecture changes (not gaps): server lifecycle / port discovery / menubar-tray removal, A/B controller → S-gauge.

**Verified parity (audit):** new `npm run build` 46/46 + typecheck + WASM inference + bundle; gauge reducer/config byte-identical; ONNX/WASM vectors, Ollama parser/prompt, key rotation, 10 personas, base sensitive-domain filter, toast clamp. Caveat: the 46 tests are almost all pure-function/provider tests — **no integration test exercises `background.ts` / `gaugeRuntime.ts` / IndexedDB / session / feedback / popup.** Porting the original's background integration tests is part of the fix.

---

## P0 — Safety / cheap correctness ✅ DONE (commits `6c80109`, `2bc6ecb`, `42557f1`)

| # | Gap | Status | Resolution |
|---|-----|--------|------------|
| P0-1 | **Sensitive-domain privacy filter** 🔴 | ✅ DONE | Ported `domainFilter.shouldDropUrl` (shared `sensitive_domains.json`). `observe()` drops sensitive pages before any judging + pauses the gauge; `showToast()` also refuses to surface a nudge there. |
| P0-2 | **Heartbeat drains S with no focus/presence check** | ✅ DONE | `browserPresent()` (window `.focused` + `idle.queryState`) gates the heartbeat; not present → dispatch `inactive`. |
| P0-3 | **No window focus/blur tracking** | ✅ DONE | `windows.onFocusChanged` → `inactive` on `WINDOW_ID_NONE`, re-observe on refocus. |
| P0-4 | **SPA / in-page navigation not observed** | ✅ DONE | `webNavigation.onHistoryStateUpdated` + `tabs.onUpdated(title)`; debounce keyed on pageKey+title so same-path title swaps re-judge. |
| P0-5 | **"목표와 관련 있어요" feedback is a no-op** | ✅ DONE | `related` dispatches `nav{verdict:OK}` for the active page → S recovers. (Full exemplar-learning remains P3-4, blocked on SSOT.) |
| P0-6 | **System-notification fallback dropped** | ✅ DONE | `chrome.notifications` fallback with 관련/5분 buttons wired to the same feedback handler when the toast can't inject. |
| P0-7 | **`max_sentences` clamp not enforced** | ✅ DONE | Ported `clamp_notification_message` (domain/decimal-aware); every nag clamped to `persona.maxSentences ?? 2`. Parity tests added. |

## P1 — Core judging quality ✅ DONE (commits `70de…`→`P1-6`)

| # | Gap | Status | Resolution |
|---|-----|--------|------------|
| P1-1 | **Page content/excerpt — Tier-2 judged title+host only** | ✅ DONE | Ported `extractPageExcerpt`; `serviceTier2` injects it into the active (non-sensitive, still-judged) tab and threads the body text into `buildTier2ReviewPayload` as `page_excerpt`. |
| P1-2 | **Pages judged instantly — no dwell delay** | ✅ DONE | `observe()` schedules judgement after `OBSERVE_DWELL_MS` (5 s); nav-away during the dwell cancels it (`pendingObsKey` guard). Sensitive pages still pause immediately. |
| P1-3 | **Provider-error / degraded-mode never surfaced** | ✅ DONE | `providerHealth` records classified ok/error per LLM call; popup shows a red degraded banner while Tier-0-only. |
| P1-4 | **Toolbar badge status indicator** | ✅ DONE | `badge.ts` paints green/amber/red/grey by S band + snooze on every dispatch; cleared with no goal. |
| P1-5 | **Goal-revision guard for in-flight async work** | ✅ DONE | `SessionGoal.revision` bumps on text OR minutes; reset on either; `serviceTier2` drops the Tier-2 result if the revision moved on. |
| P1-6 | **Time-budget context not sent to the LLMs** | ✅ DONE | `serviceTier2` builds `{available_time_minutes, elapsed_minutes, current_page_drift_minutes}` and threads it into both Tier-2 payloads. |

## P2 — Foundational infrastructure ✅ DONE

| # | Gap | Status | Resolution |
|---|-----|--------|------------|
| P2-1 | **Durable IndexedDB SSOT** | ✅ DONE | Added `lib/db.ts` (IndexedDB: `kv` + `observations` + `events` stores). Moved all live gauge state (S/M/accelTier, drift-since, active page) and the recent-visit / nag logs off `chrome.storage.session` onto it, so they survive **browser restart**, not just SW teardown; reads fail-safe to a fresh gauge. _Effect-outbox deferred_ — effects deliver synchronously in `deliver()`, so a cross-teardown loss is rare; revisit if it bites. |
| P2-2 | **Structured, durable observation + event log** | ✅ DONE | `lib/events.ts` — typed append-only records in the IndexedDB `events` store, logged at every decision point (observe/tier2/nag/celebrate/feedback/goal). Exportable as JSONL from the popup. The queryable substrate for P3 analytics + replay. |

## P3 — Larger features (triaged 2026-07-24: core / small / skip)

| # | Gap | Status | Effort | Notes |
|---|-----|--------|--------|-------|
| P3-1 | **Tier-0 richness: multi-exemplar + recency anchor + goal enrichment** | ✅ DONE | L | `lib/relevance.ts` scores `max(exemplar, β·anchor, derived)`; "관련 있어요" adds a page exemplar; confirmed-OK pages join a guarded recency anchor; `lib/goalEnrichment.ts` expands the goal into cross-lingual derived exemplars on goal change. Vectors per-goal in the SSOT. Parity tests. |
| P3-4 | **"related"/"drift" labeling → exemplar learning** | ✅ DONE | M | Folded into P3-1: `related` embeds the page and adds a goal exemplar (the user-taught relevance loop) + recovers S. (Report-verdict override lands with P3-3.) |
| P3-3 | **Self-focus analytics: session stats / report / history** | CORE (next) | L | "How did my focus go today" — focus ratio, hourly strip, top drift hosts, longest OK stretch. On a **separate page**. Aggregates the `events`/`observations` stores. |
| P3-5a | **Core settings (options page)**: `tau_ok`, **quiet hours**, **voice/TTS toggle**, **delete-all data**, persona/Ollama moved here | ✅ DONE | M | MV3 `options_ui` page in the mockup design language; `lib/settings.ts` (durable). tau_ok now read per-observation; quiet hours suppress nags; TTS reads the nudge aloud (offscreen Web Speech); delete-all wipes activity data. Popup slimmed to goal + gauge + 설정 link. |
| P3-6 | **Session replay / counterfactual tuning** | ✅ DONE | L | `lib/replay.ts` re-runs the event log under a tau sweep via `reduceGauge` + relevance threshold (no server/DB). `tools/replay.ts` = Node CLI over an exported JSONL (runnable outside the browser); `src/replay` = in-extension page (IndexedDB or uploaded JSONL) with tau sweep + tau→nag gauge re-run + S chart. Parity tests. |
| P3-2 | **SEO title-suffix stripping** | SMALL | S | `strip_repeated_title_suffix` ("- 나무위키") — a tiny pure fn fed by recent-titles-per-host. Modest gain. |
| P3-5b | Cooldown / dwell seconds settings | SHRINK/DEFER | S | Constants already work; expose only as an advanced toggle if at all. |
| P3-8 | Session pause + end summary | SMALL | S | A `paused` flag short-circuiting observe/heartbeat; summary folds into P3-3. |
| **P3-5c** | ~~Controller mode (A/B α·θ·k)~~ | ❌ **SKIP** | — | **Obsolete**: the S-gauge (PR #121) replaced the A/B controllers; there is nothing to expose. |
| P3-7 | Re-point benchmark / red-team harnesses | DEFER | M | Do at server-deletion cutover; model+prompts are byte-parity meanwhile. |

## Obsolete by design (serverless) — no action

Menubar + Windows tray apps; auto-port selection / effective-port file / identity+health polling; CLI + packaged server + launch-agents/autostart; `/health` + `RuntimeResources` idle/active daemon state; popup "server unreachable" banner + last-snapshot cache. Their only transferable roles (status dot, open-logs) are covered by P1-4 and the existing `klog` export.

---

## Cross-cutting dependencies

```
P2-1 (IndexedDB SSOT) ──┬── P3-1 (Tier-0 exemplars/anchor)
                        ├── P3-3 (analytics)
                        ├── P3-4 (label learning)
                        └── (restart durability for gauge/history)
P2-2 (event log) ───────┴── P3-6 (replay harness)
P1-1 (page excerpt) ──────── unblocks recent_pages content in Tier-2
```

## Suggested first batch (all P0, all Small, no SSOT dependency)
P0-1 privacy filter · P0-2/P0-3 focus gating · P0-4 SPA nav · P0-6 notification fallback · P0-7 sentence clamp — plus P0-5 (related→S-recovery). Each is self-contained and independently shippable.

# Migration Gap Analysis — original → `extension-next`

_Generated 2026-07-24 from a 6-way subagent sweep of `apps/server/` + `apps/extension/` (ORIGINAL) vs `apps/extension-next/` (NEW serverless target)._

**Framing:** The pure decision core carried over cleanly — the gauge reducer/config (`core/gauge/*`) is **byte-identical**, and the Tier-1/2 prompts, judge→writer split, key-pool rotation, KoEn-E5 ONNX model, and the 10 personas are all faithfully ported. **Every gap below is in the wiring _around_ that core**: the observation surface, the LLM/Tier-0 _inputs_, durable storage, corrective feedback, privacy, and the user-facing surfaces. Nothing here is a reducer bug.

Legend — Effort: S(mall)/M(edium)/L(arge). "Blocked on SSOT" = needs the durable IndexedDB store (P2-1) first.

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

## P2 — Foundational infrastructure

| # | Gap | Status | Effort | Notes |
|---|-----|--------|--------|-------|
| P2-1 | **Durable IndexedDB SSOT (state + effect outbox)** | MISSING | M | **Unblocks most of P3.** Gauge state (S/M/accelTier/drift-since/active page/recent obs) lives in `chrome.storage.session` → **wiped on browser restart**; no effect outbox → a nag computed across an SW teardown is lost. Original old ext had `apps/extension/src/lib/gaugeIndexedDb.ts` (checkpoint+outbox, versioning, `importLegacy`) — adapt near-verbatim; it's unit-tested. |
| P2-2 | **Structured, durable observation + event log** | MISSING | M | Next persists only a 400-line _text_ debug ring (`klog`) + 20/40-entry context caps. No structured record of verdicts/scores/tiers/interventions/feedback. Prerequisite for analytics (P3-3) and replay (P3-6). |

## P3 — Larger features (mostly blocked on P2)

| # | Gap | Status | Effort | Notes |
|---|-----|--------|--------|-------|
| P3-1 | **Tier-0 richness: multi-exemplar + recency anchor + goal enrichment** | MISSING | L | Next implements only `exemplar_score` with **one** exemplar of `max(exemplar, anchor, derived)`. Missing: (a) multi-exemplar from "related" pages (learning loop); (b) session-recency **anchor** vector (mean of recent-OK embeddings) — catches drift-into-adjacent-subtopic; (c) **LLM goal enrichment** → cross-lingual derived phrases (terse "리팩터링" won't match English "extract method"). `completeGoalEnrichment` is ported but never invoked. Blocked on SSOT + embedding storage. |
| P3-2 | **SEO title-suffix stripping** | MISSING | S–M | `strip_repeated_title_suffix` ("- 나무위키", "\| LG전자") not ported; site furniture blunts the cosine. `history.ts` can feed recent-titles-per-host. |
| P3-3 | **Self-focus analytics: session stats / report / history views** | MISSING | L | The whole "how did my focus go today" surface (focus ratio, hourly strip, top drift hosts, longest OK stretch, exploration history) is gone. Blocked on SSOT. |
| P3-4 | **Full "related"/"drift" labeling → exemplar learning** | MISSING | M | Beyond P0-5's S-recovery: persist labels, override verdict in reports, add the page embedding as a goal exemplar. Blocked on SSOT + Tier-0 exemplar store (P3-1). |
| P3-5 | **Settings surface collapsed (~12 knobs → 3)** | MISSING | M | Absent user controls: `tau_ok` sensitivity, re-nag cooldown, observe/tier2 dwell seconds, controller params, **quiet hours**, **voice/TTS toggle** (Web Speech `speechSynthesis` analog), **delete-all activity data** (privacy), popup snooze/resume/session-end, per-page verdict card. |
| P3-6 | **Session replay / counterfactual tuning harness** | MISSING | L | `replay_session` re-ran recorded sessions under overridden config to catch detector regressions. Blocked on P2-2; could be a Node/TS script re-running the vendored `reduceGauge`+`judgeTier0` over an exported log. |
| P3-7 | **Re-point benchmark / eval / red-team harnesses** | PARTIAL | M | `scripts/benchmark_tier0_embeddings.py`, `eval_persona_voice.py`, `redteam/extract_prompt.py`, `smoke_tier*` import `apps.server.*` → break when the server is deleted. Model+prompts are byte-parity, so re-point at `OllamaChatJudgeProvider`/WASM embedder or trust the parity test. |
| P3-8 | **Session pause + end-of-session summary** | PARTIAL | M | No pause (keep goal, stop tracking) and no end recap. Add a `paused` flag short-circuiting `observe`/heartbeat. |

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

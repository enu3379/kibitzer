# Handoff: Pre-Distribution Refactor & Bug Fixes

Date: 2026-07-15
Source: multi-agent audit (31 agents — 2 mappers + 6 Opus bug-hunters +
adversarial verification + 2 maintainability agents). 20 candidate findings →
**17 confirmed** (2 high / 6 medium / 9 low), 3 refuted, all confirmed at
verifier confidence *high*.
Decision context: [planning-notes.md](planning-notes.md) D7 (packaging), D8
(app/extension split + same-repo refactor), D9 (this audit).
Full original report (Korean, verbatim): **Appendix A** at the bottom.

> **Scope of this doc.** A work order that turns the audit into ordered,
> file-anchored tasks. It does **not** include the CWD-relative config/data path
> issue — that is D7 packaging phase-0, tracked separately.

## How to read this

Each item has: **files**, **do**, **effort** (small ≈ <½ day, medium ≈ 1–2 days,
large ≈ 3+ days), **deps**, **tests**, **owner**. Owner follows the repo's
handoff convention: mechanical/plumbing → **Codex**; user-facing copy or a
product-semantics decision → **Claude/user** (discuss first). Each item is sized
to be one squash-merged PR into `dev` unless noted.

**Global gate:** `python -m pytest apps/server/tests -q` green + `apps/extension`
`npm run build` green before every PR (AGENTS.md rule 4).

---

## Track 0 — Release gate (must land before ANY distribution)

These two are the only findings that make a shipped build unusable. Do them
first, as independent small PRs.

### R1 — Malformed provider config must degrade, not crash `[high]`
- **files:** `apps/server/app/providers/judges/factory.py:212` (+ `:181`,
  `:185`); `apps/server/app/core/runtime_resources.py:138,148`
- **do:** Missing-credentials already returns `None` → Tier-0 degrade, but a
  malformed `models.local.yaml` **raises** — `ValueError` at `factory.py:212`
  (`api_style` not `openai`/`ollama` and URL lacks `/api/chat`), or
  `float()`/`int()` at `:181`/`:185` (non-numeric `timeout_sec` /
  `max_output_tokens`). The `_ensure_tier{1,2}_provider` calls run this
  **unguarded**, so a single typo in the hand-edited config makes the first
  goal-set return HTTP 400 and every subsequent browser-nav POST 500 → whole app
  unusable (reproduced end-to-end). Wrap the factory call in
  `try/except Exception` → set provider `None` +
  `record_provider_degraded(reason="config_invalid")`. The sibling
  `_describe_tier` (`runtime_resources.py:87-90`) already catches this exact
  raise — mirror that pattern into the hot path. Additionally, inside the factory
  make the numeric casts fall back to defaults + warn rather than raise.
- **effort:** small · **deps:** none · **owner:** Codex
- **tests:** new — malformed config (bad `api_style`, non-numeric numerics) →
  provider `None`, `/health` shows the tier `degraded`, goal-set succeeds,
  browser-nav returns Tier-0 verdict (not 500). Closes the "no degrade-path test"
  gap in §Tests.

### R2 — MV3 dwell timers survive service-worker suspension `[high]`
- **files:** `apps/extension/src/background.ts:126` (observation dwell),
  `:240`, `:253-257` (Tier-2 dwell)
- **do:** Both dwells are bare `setTimeout`; the MV3 worker is evicted after
  ~30s idle and silently drops the timer (no `chrome.alarms`, no persistence).
  Settings allow dwell up to 300s (`popup.ts:856-863`, `api.ts:286-287`, server
  matches), so any value >30s — ~90% of the allowed range — deterministically
  loses the observation: `observation_seconds>30` drops `postBrowserNav`
  entirely; a pending Tier-2 excerpt request never fires. User believes tracking
  is live.
  - **Full fix:** persist pending dwell (`tab_id`, `url`, expiry) to
    `chrome.storage.session`; schedule dwells >~25s via `chrome.alarms`
    (30s granularity floor) and restore on worker restart.
  - **Stopgap** (acceptable interim, smaller PR): clamp dwell ≤25s on both
    client and server so timers never outlive the worker.
- **effort:** medium (full) / small (stopgap) · **deps:** none · **owner:** Codex
- **tests:** hard to unit-test without a chrome mock; at minimum add a pure-fn
  test for the clamp/threshold logic once `background.ts` is split (M11).

---

## Track 1 — Trust & privacy bundle (recommended before first public release)

Medium findings that damage judgment trust or the "data stays local" promise.
The privacy sub-bundle (P-*) should be raised together — it also delivers the
D8/D7-item-13 localhost hardening.

### T1 — Reset session state when the goal is edited `[medium]`
- **files:** `apps/server/app/storage/sqlite.py:764` (`set_current_goal`)
- **do:** `set_current_goal` rewrites the goal row and resets `goal_exemplars`
  to position-0, but leaves `controller_states` (streak/obs_count),
  `attachment_states`, and the anchor window intact. Result under a mid-session
  goal edit: old-goal pages stay OK-whitelisted via the anchor, coldstart is
  skipped (early nags), and a fake "return" celebration can fire. Reset
  controller + attachment state on goal change and filter `recent_ok_embeddings`
  by goal version (goal_id).
- **effort:** medium · **deps:** cheaper after M2 (ingest extraction) · **owner:** Codex
- **tests:** new — edit goal mid-session → anchor/controller cleared, old-goal
  page no longer auto-OKs. (Closes a §Tests gap.)

### T2 — Serialize the browser-nav read-modify-write around the Tier-1 await `[medium]`
- **files:** `apps/server/app/api/observations.py:220` (await at `:191`)
- **do:** `ingest_browser_nav` yields the loop at
  `await tier1_provider.classify_tier1(...)`; concurrent nav requests (rapid tab
  switches) reorder, so controller streak / `drift_started_at` latch update in
  completion order, not event order — a stale DRIFT overwrites a newer OK. Add a
  per-session `asyncio.Lock` around the read-modify-write, or compare observation
  timestamps and discard stale results before applying.
- **effort:** medium · **deps:** cheaper after M2 · **owner:** Codex
- **tests:** new — two interleaved observations with a slow Tier-1 → final state
  reflects event order. (Closes a §Tests gap.)

### T3 — Use a single-key pool as primary `[medium]`
- **files:** `apps/server/app/providers/judges/factory.py:179`
- **do:** The rotation pool is only consulted when ≥2 keys resolve; a single
  pooled key is discarded. So a user with only `ollama1` set silently loses
  Tier 2 (every drift becomes an unfiltered nag); only `ollama2` loses Tier 1.
  When `api_key` is empty and the pool has exactly one key, use `pool[0]` as
  primary. **This directly hits the 1-key onboarding path D7 is about to ship.**
- **effort:** small · **deps:** none · **owner:** Codex
- **tests:** new — 1-key `.env` in each slot → corresponding tier active.

### T4 — Surface a provider that is built but 100% failing `[medium]`
- **files:** `apps/server/app/core/runtime_resources.py:153`
- **do:** A provider built with an expired key / unreachable endpoint never
  emits `provider.degraded`, so `/health` keeps reporting the tier `active`
  while the whole LLM stack is down. Add a consecutive-`provider_error` counter
  (simple circuit-breaker); past a threshold, flip health to degraded + emit the
  event.
- **effort:** medium · **deps:** none (pairs naturally with R1) · **owner:** Codex
- **tests:** new — N consecutive tier errors → `/health` degraded + one event.

### P1 — Host-header allowlist + Origin check on state-changing POSTs `[medium read / low write]`
- **files:** `apps/server/app/main.py:49`;
  `apps/server/app/api/sessions.py:151,273,303`
- **do:** `create_app()` mounts no `TrustedHostMiddleware` and no CORS. Two
  exploits confirmed cross-origin: (a) **DNS rebinding** reads goal + browsing
  report via read endpoints (external `Host` header → 200); (b) bodyless POSTs
  (`/sessions`, `/sessions/current/snooze`, `/end`) are CORS-simple requests, so
  any visited web page can **CSRF** snooze/end/reset the session (cross-origin
  200/201). Add `TrustedHostMiddleware` allowlisting `127.0.0.1:8765` /
  `localhost:8765`, and an Origin check on state-changing POSTs (allow only
  `chrome-extension://…` and absent-Origin). This is the concrete mechanism
  behind D8's "localhost hardening" note.
- **effort:** small · **deps:** none · **owner:** Codex (allowlist值/extension
  origin needs a 1-line confirm from user)
- **tests:** new — foreign Host → rejected; cross-origin POST → rejected;
  extension origin + localhost → allowed.

### P2 — Do not relay/persist incognito navigations `[low]`
- **files:** `apps/extension/src/background.ts:638`; `apps/extension/manifest.json`
- **do:** Listeners relay incognito tab events undifferentiated; title + url_host
  are persisted to sqlite, violating the no-trace expectation. Skip events where
  `tab.incognito`, or set manifest `"incognito": "not_allowed"`. (Product call:
  silently skip vs. refuse to run in incognito — **Claude/user to confirm**.)
- **effort:** small · **deps:** none · **owner:** Claude/user decision → Codex

### P3 — De-duplicate the privacy blocklist `[high payoff refactor, privacy-critical]`
- **files:** `apps/extension/src/lib/domainFilter.ts`;
  `apps/server/app/privacy/domain_filter.py`; `configs/sensitive_domains.yaml`
- **do:** The sensitive-host/keyword list **and its matching algorithm** are
  hand-duplicated on both sides. The extension is the first privacy gate, so a
  one-sided edit silently leaks sensitive URLs. Generate the TS array from the
  YAML at build time, or have the server expose the rules and the extension
  fetch-and-cache. At minimum add a CI parity test so drift fails the build.
- **effort:** small · **deps:** best paired with M13 (extension test runner) for
  the parity test · **owner:** Codex

### P4 — Remove or wire the dead privacy flags `[small, privacy-critical]`
- **files:** `configs/default.yaml`; provider send-config models
- **do:** `privacy.strip_query` and `privacy.hash_url_path` are documented
  `true` in `default.yaml` but control nothing — config over-claims privacy
  before a public release. Either wire them to real behavior or delete them (and
  update docs). **Whether we actually want query-stripping / path-hashing is a
  product decision — Claude/user first**, then Codex. (Bundle with M7.)
- **effort:** small · **deps:** none · **owner:** Claude/user decision → Codex

---

## Track 2 — Correctness cleanups (low; batch conveniently)

Not release-blocking. Group into 1–2 PRs.

| ID | files | do | effort | owner |
|---|---|---|---|---|
| C1 | `api/observations.py:201` | On Tier-1 DRIFT→OK override, also correct `r_final` (e.g. `max(r0, tau_ok)`) so the alignment EWMA/latch isn't polluted by a rescued OK counted as drift | small | Codex |
| C2 | `core/runtime_settings.py:120` | quiet-hours `start==end` currently always-true → 24/7 silent. Reject `start==end` on PUT (or treat as zero-width) **and** show quiet-hours-active state in the popup | small | Codex + Claude (copy) |
| C3 | `providers/embeddings/hash_cpu.py:9` | `TOKEN_RE` matches only ASCII/Korean → CJK/Cyrillic/Arabic/emoji titles embed to zero vector → forced DRIFT. Add char n-gram fallback when zero tokens, or widen the regex | small | Codex |
| C4 | `lib/history.ts:26` | Serialize the `chrome.storage.session` get→mutate→set via a single promise queue (display-only lost-update; minor) | small | Codex |
| C5 | `background.ts:471` | Memoize the `offscreen.createDocument` creation promise (single in-flight mutex) so concurrent notifications don't drop a chime | small | Codex |

*(C3 also closes the "no non-ASCII embedding test" §Tests gap.)*

### The 422-misread (user-facing, needs copy) `[medium]`
- **files:** `apps/extension/src/popup/popup.ts:973`, `lib/api.ts:322`
- **do:** Every popup API wrapper collapses non-2xx to `null`, rendered as
  "server unreachable". So a 422 (cooldown >86400, k >20) silently drops the
  setting *and* shows an offline banner. In `api.ts`, distinguish network
  failure from HTTP error (return the status); show a validation message on 422;
  add `max` to `#cooldown-seconds` and a k upper-bound check.
- **effort:** small · **owner:** Codex (plumbing) + **Claude** (error copy)

---

## Track 3 — Maintainability (start right after packaging phase-0)

Ordered so that dependency-unlocking refactors come first. Not release-blocking,
but the two starred items are the biggest post-launch maintenance sinks.

| ID | item | files | effort | notes / deps |
|---|---|---|---|---|
| **M2** ★ | Extract ingest pipeline | `api/observations.py:139-239` → new `core/ingest.py`; delete dead `core/pipeline.py` | medium | **Do early** — unlocks cheaper T1, T2, and controller tests |
| M3 | De-dup controller math | `observations.py:355-382` (`_drift_confirmed_after_observation`, `_next_alignment_score`) reuse `Alignment`/`StreakController` instead of reimplementing EMA/streak | medium | after M2 |
| M4 | Wire-type codegen | `lib/api.ts` (~25 hand-written interfaces) ← `/openapi.json` via `openapi-typescript` in build/CI; consolidate server inline response models into `schemas.py` | medium | catches server field renames at `tsc` |
| M5 | Split `storage/sqlite.py` (1,829 lines) | pull the 4 pure report aggregates (`_report_from_rows` etc., `:1478-1608`) → `storage/reporting.py`; gate schema bootstrap once (fixes the per-op reconnect, `sqlite.py:1625`); decide `:memory:` support explicitly | large | absorbs a low bug |
| M6 | Delete dead code | `core/anchor.py`, `logging/event_log.py`, `relevance.tier0_verdict`, `domain_filter.host_from_url`, controllers' unused `on_feedback` | small | **⚠ `on_feedback` hides a latent bug**: `'relevant'` vs the real enum `'related'`. If 'related' feedback *should* reset the streak, wire it correctly in `feedback.py` — **Claude/user to confirm intent** |
| M7 | Remove unread config | `embedding.model`/`batch_size`, `delivery.channel`, `Tier1SendConfig.url_path`/`page_excerpt` (+ P4's privacy flags) | small | bundle with P4 |
| M8 | Fix the CLI entry point | `pyproject.toml` `kibitzer` → `SystemExit('not implemented')` stub; implement a minimal "start server" launcher (needed for the single-binary anyway) or remove the entry | small | feeds D7 packaging |
| M9 | Hoist duplicated prompts | Tier-2 system prompt ×3 (already diverged), Tier-1 ×2, Korean fallback drift copy ×2 → shared prompts module | small | copy-touching → Claude reviews |
| M10 | Finish `KIBITZER_PORT` wiring | recognized only by macOS scripts/menubar; Windows scripts + extension (`SERVER_BASE_URL` hardcoded) ignore it → silent break. Wire end-to-end or drop the override for a single 8765 constant; align setup docs; `macos_setup` `npm install`→`npm ci`, reconcile Python 3.12-vs-3.11 preference | small | feeds D7; docs → Claude |
| M11 | Split `background.ts` (663 lines) | badge renderer (~100 lines) → `lib/badge.ts`; toast state machine (~180 lines) → `lib/notifications.ts` (unit-testable). Defer `popup.ts` (979 lines) split to post-packaging | medium | enables R2's clamp test |
| M12 | Misc | unify settings validation via `ControllerConfig.model_validate`; collapse the 3 `'window'`→`'alignment'` aliases to 1; fix `build_tier1_payload` `Goal` annotation → `GoalRecord` | small | — |

★ = highest post-launch payoff.

---

## Track 4 — Test coverage (write alongside M2/M3, cheaper after)

**Server** (`apps/server/tests`):
- `StreakController` direct unit tests (coldstart gate, k threshold, cooldown,
  snooze) — currently only covered indirectly via the HTTP handshake.
- `apply_controller` (streak/alignment dispatch + state persistence).
- `RuntimeResources` credentials-missing → provider `None` → single
  `provider.degraded` event path (also covered by R1's test).
- alignment branch of celebration detection (`_next_alignment_score`);
  attachment tests only exercise streak mode today.
- Gaps that confirmed bugs exposed: concurrency (T2), goal-change reset (T1),
  non-ASCII embedding (C3).

**Extension** (`apps/extension`): **no test runner exists** — `npm test` is
`tsc --noEmit`, CI only builds. `shouldDropUrl` (privacy gate),
`normalizeSettings` (hand-copied server Pydantic ranges + theta order), history
dedup/cap are all pure functions — this is pure omission, not a harness problem.
Add **vitest** and start with those three modules; that seam also carries the
P3 blocklist-parity test and M4 wire-type validation.

---

## Suggested sequencing (dependency graph)

```
Release gate:      R1 ──┐         R2 (stopgap or full)
                        │
Trust bundle:      T3, T4, P1, P3, P4  (parallel, small)
                   T1, T2  ── depend on ──▶ M2 (do M2 first if bundling)
                                             │
Maintainability:   M2 ★ ──▶ M3 ──▶ Track-4 controller tests
                   M13 (vitest) ──▶ P3 parity test, M4 validation
                   M5, M6, M7/P4, M8, M9, M10, M11, M12  (independent)
Packaging (D7-0):  runs in parallel; M8 + M10 feed it
```

Practical first PRs, in order:
1. **R1** (factory degrade) — smallest, safest, closes a test gap.
2. **R2 stopgap** (dwell clamp) — unblocks the release gate cheaply; full
   `chrome.alarms` fix can follow after M11.
3. **T3 + P1** — tiny, and both protect the D7 onboarding path.
4. **M2** (ingest extraction) — the keystone; makes T1/T2 and controller tests
   cheap. Then T1, T2.
5. **M13** (vitest) + **P3** parity test.

Everything lands as small `fix/*` / `chore/*` / `refactor/*` PRs into `dev`
(AGENTS.md workflow). Branch from `dev`, not from any feature branch.

---

## Appendix A — Original audit report (verbatim, Korean)

> Generated 2026-07-15 by the pre-distribution audit workflow (task
> `wrr2kimts`). Preserved verbatim as the source of record for every item above.
> Stats: 17 confirmed (2 high / 6 medium / 9 low), 3 refuted, 15 maintainability
> items. Refuted (for the record): voice task GC, `renderReport` unguarded,
> OS-notification feedback loss — all had an impossible failure mechanism.

# Kibitzer 배포 전 감사 최종 보고서

대상: `/Users/eunu03/kibitzer` (FastAPI 서버 + Chrome MV3 확장) · 기준일 2026-07-15
후보 발견 20건 중 적대적 검증을 통과한 17건을 확정, 3건 기각. 알려진 이슈(CWD-상대 config/data 경로)는 packaging phase-0으로 이미 계획되어 있어 본 보고서에서 제외.

---

## ① 배포 차단급 버그 (high)

### 1. malformed `models.local.yaml`이 degrade 대신 hot path를 크래시시킴
- **위치**: `apps/server/app/providers/judges/factory.py:212` (그리고 `:181`, `:185`)
- **요약**: credentials 누락은 `None`을 반환해 Tier 0으로 degrade하지만, config 형식 오류는 `ValueError`를 raise한다 — `api_style`이 "openai"/"ollama"가 아니고 URL에 `/api/chat`이 없으면 `:212`에서, `timeout_sec`/`max_output_tokens`가 비숫자면 `:181`/`:185`의 `float()`/`int()`에서. 이 factory 호출은 `runtime_resources.py:138/148`의 `_ensure_tier{1,2}_provider`가 **unguarded**로 실행한다.
- **실패 시나리오**: 사용자가 OpenAI-호환 endpoint를 쓰면서 `api_style: "openai"`를 빼먹거나 `max_output_tokens: "640 tokens"`처럼 적으면 — `configs/experiment-models.example.yaml`이 직접 편집을 안내하는 파일이다 — 첫 goal 설정이 HTTP 400("unsupported experiment Tier 2 api_style")으로 실패해 **앱 전체가 사용 불가**. goal이 이미 저장된 상태에서 config가 깨지면 모든 browser-nav POST가 500. 실제 앱에서 end-to-end 재현 완료.
- **권장 수정**: `_ensure_tier{1,2}_provider`에서 factory 호출을 `try/except Exception`으로 감싸 provider를 `None`으로 두고 `record_provider_degraded(reason="config_invalid")`를 기록. 같은 파일의 `_describe_tier`(runtime_resources.py:87-90)는 이미 동일한 raise를 catch하고 있으므로 이 패턴을 hot path에도 적용하면 된다. 추가로 factory 내부에서 numeric cast 실패 시 기본값 fallback + 경고 로그를 권장.

### 2. MV3 service worker 수명(~30s)을 넘는 dwell 타이머가 `setTimeout`으로 구현됨
- **위치**: `apps/extension/src/background.ts:126` (observation dwell), `:240/:253-257` (Tier 2 dwell)
- **요약**: 두 dwell 모두 bare `setTimeout`이며, MV3 worker는 idle ~30초에 종료되면서 타이머를 버린다. `chrome.alarms` 재예약이나 상태 영속화가 전혀 없다. 설정 UI는 두 dwell을 최대 300초까지 허용(`popup.ts:856-863`, `api.ts:286-287`, 서버도 동일 범위 허용)하므로 30초 초과 값에서는 **확정적으로** 유실된다.
- **실패 시나리오**: `tier2_seconds=60` 설정 후 drift 발생 → `request_excerpt` 수신 → `delay(≈55000ms)` 대기 중 worker eviction → excerpt 추출/Tier 2 개입이 영원히 발생하지 않음. `observation_seconds > 30`이면 `postBrowserNav` 자체가 유실. 사용자는 추적이 살아있다고 믿지만 관측이 조용히 삼켜진다 — 허용 설정 범위의 약 90%에서 핵심 기능이 무음 실패.
- **권장 수정**: pending dwell 상태(tab_id, url, 만료 시각)를 `chrome.storage.session`에 영속화하고, ~25초를 넘는 dwell은 `chrome.alarms`(최소 30초 단위)로 예약 + worker 재기동 시 복원. 근본 수정 전 최소한의 응급조치로는 클라이언트/서버 양쪽에서 dwell 상한을 25초로 clamp.

---

## ② 그 외 확인된 버그 (medium / low)

| 위치 | 심각도 | 요약 | 권장 수정 |
|---|---|---|---|
| `storage/sqlite.py:764` | medium | 세션 중 goal 수정 시 이전 goal의 anchor·`controller_states`·`attachment_states`가 새 goal로 그대로 이월 — 옛 goal 페이지가 새 goal에서도 OK 판정(anchor whitelist), coldstart 생략으로 조기 개입, 가짜 "복귀" 축하 | `set_current_goal`에서 controller/attachment 상태 리셋 + `recent_ok_embeddings`를 goal 버전(goal_id)으로 필터링 |
| `api/observations.py:220` | medium | Tier 1 `await` 지점에서 동시 nav 요청이 재정렬되어 controller streak / `drift_started_at` latch가 이벤트 순서가 아닌 완료 순서로 갱신됨 (stale DRIFT가 최신 OK를 덮어씀) | 세션 단위 `asyncio.Lock`으로 read-modify-write 구간 직렬화, 또는 적용 전 관측 timestamp 비교로 stale 결과 폐기 |
| `providers/judges/factory.py:179` | medium | rotation pool은 키 2개 이상일 때만 사용되고 단일 pool 키는 버려짐 — `.env`에 `ollama1`만 설정한 1-key 사용자는 Tier 2가 조용히 비활성화(모든 drift가 무필터 nag로 확정), `ollama2`만 설정하면 Tier 1 비활성화 | `api_key`가 비었고 pool에 키가 1개면 `pool[0]`을 primary로 사용 |
| `core/runtime_resources.py:153` | medium | 생성됐지만 100% 실패하는 provider(만료 키, 도달 불가 endpoint)는 `provider.degraded` 이벤트가 없고 `/health`가 계속 "active" 보고 — LLM 스택 전면 다운을 사용자가 알 수 없음 | `tier{1,2}.provider_error` 연속 실패 카운트를 health에 반영(간단한 circuit-breaker), 임계 초과 시 degraded 이벤트 기록 |
| `popup/popup.ts:973` (+ `lib/api.ts:322`) | medium | 모든 non-2xx를 `null`로 접어 "서버 연결 안 됨"으로 오진 — 특히 422(cooldown>86400, k>20)에서 설정이 조용히 미적용되고 오프라인 배너 표시 | `api.ts`에서 네트워크 실패와 HTTP 오류 구분(상태코드 반환), 422는 검증 메시지 표시; `#cooldown-seconds`에 `max` 속성 및 k 상한 검사 추가 |
| `main.py:49` + `api/sessions.py:273/303/151` | medium(읽기)/low(쓰기) | **병합 항목**: Host/Origin 검증 미들웨어 전무 → (a) DNS rebinding으로 goal·방문 기록 report 원격 읽기 가능(외부 Host 헤더로 200 확인), (b) bodyless POST(`/snooze`, `/end`, `/sessions`)는 preflight 없는 simple request라 임의 웹페이지가 CSRF로 세션 snooze/종료 가능(교차 출처 200/201 확인) | `TrustedHostMiddleware`로 `127.0.0.1:8765`/`localhost:8765` allowlist + 상태 변경 POST에 Origin 검사(`chrome-extension://` 및 Origin 부재만 허용) |
| `api/observations.py:201` | low | Tier 1이 DRIFT→OK로 뒤집어도 `r_final`이 Tier 0 값으로 고정 → alignment controller EWMA가 rescued OK를 drift처럼 반영, latch 오염 | Tier 1 override 시 `r_final`도 보정(예: `max(r0, tau_ok)`) |
| `core/runtime_settings.py:120` | low | quiet hours `start == end`가 무조건 True → 모든 알림·축하가 24/7 무음, 원인 표시 없음 | PUT 검증에서 start==end 거부(또는 zero-width 해석), popup에 quiet-hours 활성 상태 표시 |
| `storage/sqlite.py:1625` | low | 모든 store 호출마다 새 sync sqlite3 연결 + `_ensure_schema` executescript 재실행이 event loop를 블록 (browser-nav 1건당 8-10회) | schema bootstrap을 `initialize()` 1회 + 인스턴스 플래그로 gate (③-5 storage 분리와 함께 처리) |
| `storage/sqlite.py:804` | low | 관측마다 256-dim embedding을 영구 저장(보존 정책 없음), report는 세션 전체 관측을 무제한 직렬화 | anchor window 이탈 후 `emb` 제거 또는 별도 테이블+pruning; report judgments에 LIMIT |
| `providers/embeddings/hash_cpu.py:9` | low | `TOKEN_RE`가 ASCII/한글만 매칭 → 중국어/일본어/키릴/아랍어/이모지 제목은 zero vector → 무조건 DRIFT (Tier 1 escalation 낭비, degrade 시 오탐 nag) | 토큰 0개일 때 문자 n-gram fallback, 또는 TOKEN_RE에 CJK/가나/키릴 범위 추가 |
| `lib/history.ts:26` | low | `chrome.storage.session` get→mutate→set 무잠금 → 탭 병행 시 탐색 기록 항목/판정 lost-update (표시 전용 데이터, 영향 경미) | 단일 promise queue로 쓰기 직렬화 |
| `background.ts:471` | low | 동시 알림 2건이 둘 다 `getContexts()==0`을 보고 `offscreen.createDocument` 경합 → 한쪽 chime 유실 | 생성 promise를 memoize(단일 in-flight promise mutex) |
| `background.ts:638` | low | incognito 탭 이벤트를 구분 없이 서버로 중계, title+url_host가 sqlite에 영구 저장 — incognito 무저장 기대 위반 | 리스너에서 `tab.incognito` 스킵, 또는 manifest에 `"incognito": "not_allowed"` |

(모든 항목 verifier confidence: high — 저신뢰 플래그 대상 없음)

---

## ③ 유지보수성 리팩터링 추천 (payoff 순)

**Payoff: high**

1. **Privacy blocklist 이원화 해소** — `apps/extension/src/lib/domainFilter.ts` vs `configs/sensitive_domains.yaml`+`app/privacy/domain_filter.py`. 목록과 매칭 알고리즘이 양쪽에 손으로 중복되어 있어 한쪽만 수정하면 민감 URL이 조용히 전송된다(확장이 1차 privacy gate). 빌드 타임에 YAML→TS 배열 생성 또는 서버가 rules를 노출하고 확장이 fetch-and-cache. 최소한 parity 테스트로 CI에서 drift 차단. *(effort: small)*
2. **Ingest pipeline 추출** — `api/observations.py:139-239`의 ~100줄 `ingest_browser_nav`가 제품의 핵심 로직인데 HTTP 레이어를 통해서만 테스트 가능. `core/ingest.py`로 추출하고 dead legacy인 `core/pipeline.py` 삭제. ①-1, ②의 동시성 수정도 이 추출 후가 훨씬 쉽다. *(effort: medium)*
3. **Controller 로직 중복 제거** — `observations.py:355-382`의 `_drift_confirmed_after_observation`/`_next_alignment_score`가 `AlignmentController`/`StreakController`의 EMA·streak 공식을 재구현. controller가 `confirmed_drift` 결과를 노출하게 하고 재계산 제거. *(effort: medium)*
4. **Wire type codegen** — `lib/api.ts`의 ~25개 수제 인터페이스 vs 서버 Pydantic 모델이 무연결. `/openapi.json` → `openapi-typescript`를 빌드/CI 단계로 추가하면 서버 필드 rename이 `tsc`에서 잡힌다. 서버 쪽 inline response 모델도 `schemas.py`로 통합. *(effort: medium)*
5. **`storage/sqlite.py` (1,829줄) 분해** — aggregate별 분리, 최소한 순수 report 집계 4개(`_report_from_rows` 등, :1478-1608)를 `storage/reporting.py`로. schema bootstrap을 per-query에서 1회로 gate(②의 low 버그 해결과 동일 작업). `:memory:` 지원 여부도 명시적으로 결정(현재 per-op fresh connection이라 사실상 비작동). *(effort: large)*

**Payoff: medium**

6. **Dead code 삭제** — `core/anchor.py`, `logging/event_log.py`, `relevance.tier0_verdict`, `domain_filter.host_from_url`, 그리고 세 controller의 `on_feedback` (호출처 없음 + `'relevant'` vs 실제 enum `'related'` 문자열 불일치라는 잠재 버그를 가림). 'related' 피드백 시 streak 리셋이 실제로 원한 동작이면 feedback.py에서 올바른 enum으로 명시적으로 연결. *(small)*
7. **읽히지 않는 config 제거 / privacy 플래그 배선** — `embedding.model`·`batch_size`, `delivery.channel`, `Tier1SendConfig.url_path`·`page_excerpt`, 그리고 특히 `privacy.strip_query`·`hash_url_path`는 아무것도 제어하지 않는데 default.yaml에 true로 문서화되어 있어 **배포 전 config가 privacy 동작을 과장하지 않도록 반드시 정리**. *(small)*
8. **깨진 CLI entry point** — pyproject.toml이 `kibitzer` 명령을 `SystemExit('not implemented')` stub에 연결. 최소한의 'start server' launcher를 구현(single-binary 배포에 어차피 필요)하거나 entry 제거. *(small)*
9. **프롬프트/fallback 상수 중복** — Tier 2 system prompt 3벌(이미 문구 divergence 발생), Tier 1 prompt 2벌, 한국어 fallback drift 문구 2벌. 공용 prompts 모듈로 hoist. *(small)*
10. **`KIBITZER_PORT` 반쪽 배선** — macOS 스크립트/메뉴바만 인식, Windows 스크립트와 확장(`SERVER_BASE_URL` 하드코딩)은 무시 → macOS에서 설정 시 무음 단절. end-to-end로 배선하거나 override 제거해 8765 단일 상수로 확정 + 양 setup 문서에 반영. macos_setup의 `npm install`→`npm ci`, Python 버전 선호(3.12 vs 3.11) 정렬. *(small)*
11. **`background.ts` (663줄) 분해** — badge 렌더러(~100줄)와 toast 상태머신(~180줄)을 `lib/badge.ts`/`lib/notifications.ts`로 추출해 단위 테스트 가능하게. popup.ts(979줄) 분리는 packaging 이후로 유예. *(medium)*

**Payoff: low**

12. settings 검증을 `ControllerConfig.model_validate`로 일원화, 'window'→'alignment' alias 3곳→1곳, `build_tier1_payload`의 `Goal` annotation을 실제 전달 타입(`GoalRecord`)으로 수정. *(small)*
13. setup 문서는 현재 정확하나 gate 없음 — port 스토리 확정 후 양 가이드 갱신, 장기적으로 스크립트 self-describing에 의존해 prose 축소. *(small)*

---

## ④ 테스트 커버리지 공백

**서버** (`apps/server/tests`):
- `StreakController` 직접 단위 테스트 없음 (coldstart gate, k 임계, cooldown, snooze) — HTTP handshake 경유로만 간접 커버.
- `apply_controller` (streak/alignment dispatch + 상태 영속화) 직접 테스트 없음.
- `RuntimeResources` credentials-missing → provider None → 단일 `provider.degraded` 이벤트 경로 테스트 없음.
- 축하 감지의 alignment 분기(`_next_alignment_score`) 미테스트 (attachment 테스트는 streak 모드만 사용).
- **확정 버그가 드러낸 공백**: 동시 요청 테스트 전무(②-2), goal 변경 시 상태 리셋을 pin하는 테스트 전무(②-1), 비한글/비ASCII 임베딩 케이스 전무(②의 hash_cpu 건).

**확장** (`apps/extension`): 테스트 러너 자체가 없음 — `npm test`는 `tsc --noEmit`, CI는 빌드만. `shouldDropUrl`(privacy gate), `normalizeSettings`(서버 Pydantic 범위 수제 복제 + theta 순서), history dedup/cap 모두 chrome.* 의존 없는 순수 함수라 하네스 문제가 아닌 순수 누락. vitest 도입 후 이 3개 모듈부터 시작 — blocklist parity 테스트(③-1)와 wire-type 검증의 기반이 된다.

우선순위: ③-2(pipeline 추출)와 ③-3(controller 통합) 이후에 작성하면 비용이 크게 줄어든다.

---

## ⑤ 종합 판정

후보 발견 20건을 적대적 검증에 걸어 17건 확정·3건 기각(voice task GC, renderReport 미가드, OS-notification 피드백 유실 — 모두 주장된 실패 메커니즘이 실제로는 불가능)했으며, 확정 건은 전부 confidence high로 코드 경로 추적 또는 실행 재현까지 완료된 상태다. 배포를 차단하는 것은 high 2건 — config 오타 하나로 앱 전체가 죽는 factory `ValueError`와, 설정 범위의 대부분에서 핵심 관측이 무음 유실되는 MV3 dwell 타이머 — 이며 둘 다 국소적 수정(unguarded 호출 try/except + degrade, `chrome.alarms` 전환 또는 dwell 상한 clamp)으로 해결 가능하다. medium 6건 중 goal-수정 상태 이월과 provider health 오보고는 제품의 판정 신뢰성에 직결되므로 첫 공개 릴리스 전에 함께 처리할 것을 권장하고, privacy 항목(Host/Origin 검증, incognito, blocklist 이원화, 죽은 privacy 플래그)은 "데이터는 로컬에 머문다"는 제품 약속과 직접 충돌하므로 낱개 심각도보다 묶음으로 우선순위를 높일 가치가 있다. 그 외 low 9건과 리팩터링 항목은 배포를 막지 않으나, 확장 테스트 하네스 부재와 pipeline god-function은 배포 후 유지보수 비용의 최대 원천이 될 것이므로 packaging phase-0 직후 착수를 권장한다.

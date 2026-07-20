# Planning Notes — Claude ↔ User

Living working doc. Unlike `progress.md` (a log of completed work) and
`roadmap-fun-layer.md` (the master product plan), this file is where Claude and
the user think out loud and record decisions as they are made. Edit freely from
both sides; keep the "Open decisions" statuses current.

Last updated: 2026-07-20.

## Where the project actually is (verified 2026-07-08)

Two tracks ran in parallel since the P0 persona engine landed:

| Track | Item | State |
|---|---|---|
| A. Fun layer | P0 persona engine + voice + quiet hours + popup settings | ✅ merged |
| | P1 attachment loop (plumbing + design/copy layer) | ✅ feature-complete 2026-07-08 |
| B. Runtime / OS | idle daemon + macOS LaunchAgent (PR #1) | ✅ merged |
| | controllers A안 (alignment/EWMA) + B안 (streak), settings-configurable | ✅ merged |
| | dwell gating (observe 5s / excerpt 10s) | ✅ merged |
| | Windows startup tray (PR #2) | ✅ merged |
| | macOS menu bar status item | ✅ merged (PR #3); alpha-dot spec pending (backlog #5) |
| | detection fixes + in-page toast + Ollama Cloud stack + key rotation | ✅ merged (PR #6–#9) |
| New (doc only) | `judgment-audit-plan.md` — detection-quality overhaul | 📋 designed, gated on D4 |

Baseline: 90 server tests green; server runs in idle daemon mode.

**Re-verified 2026-07-20** (`origin/dev` through PR #109): Tier 2 has since
been split into a Context Judge / persona Message Writer with threshold-timed
precomputation (`331a0ba`, supersedes the single guarded call), the persona v5
lineup ships as `configs/personas/` fragments, Windows tray moved to an
in-server pystray lifecycle (#105) on a packaged-runtime foundation
(`dc04c98`), and provider failures are classified and surfaced in the popup
(#108/#109). Baseline now 275 server tests + 45 extension tests. PRs
#69/#71/#74 were closed unmerged on 2026-07-18 — their functional content was
reconciled into `331a0ba`; red-team-harness preservation is pending as draft
PR #106. The pre-reconciliation local worktree is archived on branch
`archive/security-hardening-20260720`.

## The pivot: trust before more personality

`judgment-audit-plan.md` came out of a real dogfooding session (goal
"국내 여행지 탐색", 118 observations) and documents systematic FALSE OKs on
multi-purpose platforms: overseas Airbnb listings and Naver shopping/webtoon
passed Tier 0 as OK; one `관련 있어요` on a generic platform title whitelisted the
whole platform. The roadmap's hard precondition is explicit — false-positive
nagging cannot be saved by humor; trust features outrank personality features.

Critical-path insight: the whole audit plan is gated on the **Replay CLI**
(long-deferred WP10). Its Step 0 is "label the log and build histograms," which
needs a replay harness. So the Replay CLI is the true unlock.

### Evidence: 2026-07-08 "LG그램 수리" session (sess_f249ac14…)

A 6-minute live session failed in *both* directions, all at Tier 0
(`tier_reached=0` on every row):

1. **Cold-start FALSE DRIFTs ×6** — the user booking the repair (LG 서비스센터 /
   고객지원 / 출장 예약) scored r0 0.06–0.13 because "수리" shares no CJK bigrams
   with "서비스센터/예약" and `keywords_json` was `[]` (no goal enrichment → D3).
2. **Anchor hijack FALSE OKs ×5** — "킬로그램 - 나무위키" entered OK via the
   "그램" bigram, its "나무위키" title furniture entered the anchor (mean of last
   10 OK embeddings), and then Giggle/미니언즈/현덕왕후/호날두 all rode
   `0.85 × cos(anchor)` past τ=0.15. The reference frame drifted with the user —
   platform self-whitelisting without any feedback click.
3. **Why Tier 0 only:** Tier 1/2 run as `provider: experiment`, which reads
   `configs/models.local.yaml` — the file is missing on this Mac (likely lost in
   the Windows-packaging config-path change; a 07-06 `tier1.provider_error:
   ReadTimeout` proves Tier 1 used to run). Since 07-07 every server start logs
   `provider.degraded credentials_missing` — silently, nowhere user-visible.
   Ollama itself is up (qwen3.6:27b, gemma4:26b, gemma4:e4b).

**Agreed fixes — all IMPLEMENTED 2026-07-08 (78 server tests green):**
(1) per-host repeated-title-suffix stripping in normalization ("- 나무위키" /
"| LG전자" furniture) — `strip_repeated_title_suffix`; (2) anchor admission
guard: pages whose OK came only from the anchor path (exemplar score <
`relevance.anchor_epsilon`, default 0.05) or that weren't LLM-vetted keep the OK
verdict but are NOT admitted into the anchor — `features.anchor_eligible`,
filtered in `recent_ok_embeddings`; (3) `models.local.yaml` restored — Ollama Cloud, tier1 → gemma3:4b (e4b does
not exist on cloud; caught by per-key probing), tier2 → gemma4:31b — later the
same day superseded by nemotron-3-super / minimax-m3 (see D3); live
`/health` shows `tiers: active`, all three keys individually verified and tier
degradation surfaced in `/health` + a popup warning ("판정 축소 모드").
Regression test `test_drift_fixes.py` replays the 나무위키 chain end-to-end.
Still deferred to the audit plan as scheduled — goal enrichment (D3) and
threshold tuning via Replay CLI (D4). Note Tier 1 only reviews Tier-0 DRIFTs
(false-nag rescue); the FALSE-OK side is carried entirely by fixes 1–2.

## Open decisions

### D1 — Sequencing → RESOLVED (2026-07-07)

Replay CLI is the critical path (it unblocks the judgment audit). In parallel,
Claude prepares P1 "return celebration" only — it is pure templates, adds no new
detection logic, and carries zero false-positive risk, so it gives delight
without touching the trust spine. The rest of P1 (report, transparency) waits
until the audit reshapes the exemplar/anchor structures.

### D2 — macOS menu bar visual → RESOLVED (2026-07-07)

The current Swift renders a colored dot (red/gray/green/yellow) — exactly the
"Windows-like, tone-mismatched" look the user rejected. New direction: a
monochrome macOS **template** glyph (auto-tints for light/dark, RunCat / Claude /
Codex style) distilled from the KIBITZER face, plus a status **dot whose
brightness (alpha) and pulse encode state — no color**. Feasibility confirmed:
template images preserve alpha under system tint, and a RunCat-style timer drives
the pulse. Claude owns the glyph geometry + state spec; the Swift wiring is the
follow-up. State → dot mapping is in the design section below.

**Icon mark resolved (2026-07-07):** the old "KIBITZER face" (ring + brow + eyes +
green mouth) read as a frown/moustache at small sizes — the brow sat below the
eyes. Replaced by a new **"peek-over-monitor" kibitzer**: a dark head peeking from
behind a green monitor, a light rim separating head from screen, two hands draped
over the top edge, eyes cresting above. This is now the shipped **extension
toolbar icon** (`icon-128.svg` + regenerated PNG set via `gen_extension_icons.py`).
A **wall** variant (peek over a ledge) is kept as an alternate under
`apps/extension/icons/variants/` (color + menubar-mono SVGs, both rendered by
`scripts/gen_icon_variants.py`). For the menubar **template** glyph, reuse
`variants/monitor-v1-mono.svg` but cut the rim as a **transparent slit** — head and
screen are the same ink in mono, so a solid rim would merge them; the color icon
uses a light rim instead.

### D3 — Goal-enrichment LLM call → RESOLVED + IMPLEMENTED (PR #26, 2026-07-14)

The audit plan adds one cheap LLM call at goal declaration to derive positive
goal phrases. Only the goal text leaves the call site; no page content.
Direction update (2026-07-08, user): the stack runs on **Ollama Cloud** (tiers
use nemotron-3-super / minimax-m3 there — newest free-tier models by live probe) — drop the local-first framing; the
enrichment call rides the same Tier 1 cloud provider. PR #26 implemented the
prompt/shape, async best-effort derivation, persistence, replay, and Tier 1
integration.

Design record (2026-07-08/09, kept for reference): enrichment MUST produce
**cross-lingual phrases (Korean + English)** and sub-topic vocabulary — the
private labeled corpus shows the dominant Tier-0 failure is false-DRIFT
(80/142 related pages under τ), mostly Korean goal ↔ English page titles plus
unreachable sub-topic words; threshold tuning cannot fix a 0.00-mass. The
corpus stays local (browsing history); set `KIBITZER_AUDIT_CORPUS` to rerun
its regression test. Shape (details in
[handoff-goal-enrichment.md](handoff-goal-enrichment.md)): one async call at
goal declaration (Tier-1 cloud stack, goal text only), K≤8 phrases via a
strict prompt (~half English when the topic lives in English), stored in a
separate `goal_derived_exemplars` table, matched at a separate higher
threshold `derived_tau=0.25` (pre-flight eval: keeps 52/55 fixed false-DRIFTs
while cutting new false-OKs 7→2), and the derived phrases also ride the
Tier 1 payload as the cross-lingual bridge.

### D4 — Replay CLI scope → RESOLVED + IMPLEMENTED (PR #14, 2026-07-10)

Replay re-simulates the per-session learning trajectory (goal seeding,
exemplar/anchor updates, recorded higher-tier outcomes, and controller state)
rather than merely rescoring stored `r0`. PR #14 shipped the read-only replay
core and CLI; live-tier replay remains a separate optional follow-up.

### D5 — Developer diagnostics view → RESOLVED + IMPLEMENTED (PR #13, 2026-07-09)

The popup exposes the latest page verdict and a hidden developer-diagnostics
layer (`r0`, threshold, exemplar score, anchor admission, tier, and reason).
PR #13 also added page labels and the latest-observation API. Richer audit
routing and title-quality labeling remain part of the judgment-audit chain,
not this decision.

### D6 — Extension distribution → DECIDED (deferred, 2026-07-07)

`dist/` and `node_modules/` are gitignored (correctly — the repo ships source, not
a built bundle), so sharing today is dev-only: clone → `npm install` →
`npm run build` → Load unpacked `apps/extension/dist`. CI already builds this on
macOS + Windows. When wider sharing is needed, go **option 1**: have CI zip `dist/`
and attach it to a GitHub Release on tag, so a non-builder can download
`kibitzer-extension.zip`, unzip, and Load unpacked. Deferred — not building now.
Rejected: committing `dist/` (git churn). Chrome Web Store stays a later option for
true end-user distribution.

Update 2026-07-15: partly superseded by D9 — the Web Store moves from "later
option" to a prerequisite of the app-onboarding flow; the CI release-zip remains
the interim bridge until the listing is live.

### D7 — Time-budget drift rule → RESOLVED + IMPLEMENTED (PR #49, 2026-07-15)

Goal declaration gains an optional **available-time budget** ("몇 시간 사용").
Drift stops being purely event-counted and becomes time-aware: the nag fires
only after drift consumes a meaningful slice of the declared budget, and Tier 2
can defer a warning when a side branch is reasonable for that budget.

`controller.type` selects the clock semantics as well as the event rule:

- **연속 (streak)** uses continuous drift since the last OK; an OK resets it.
- **누적 (alignment)** uses cumulative session drift time without resetting.
- Both modes also track current-page drift dwell.

The threshold contract is a total budget fraction (default 1/6, with a minimum),
a current-page floor, and a single-page escape valve at half the total. Without
an explicit budget, a fixed fallback keeps the time rule active. Tier 2 runs at
threshold crossings and can defer to the next multiple of the total clock.
Extension heartbeats preserve the clocks across MV3 worker teardown and tab
changes; the server remains the clock owner. PR #49 implemented the full
time-budget path, content capture, persistence, and review scheduling.

Design details kept for reference (2026-07-14): sub-`per_page` drift dwell
counts toward the mode clock, creating an explicit pending ("유보") state —
deliberately "an opportunity given to the user", not a bug; after an
"acceptable" deferral, re-judge at the next multiple of `total` on the mode
clock; dwell detection is an extension heartbeat (~30–60 s via
`chrome.alarms`) while the server owns all clocks and threshold decisions.

**Tier 2 rework (designed 2026-07-16, merged as `331a0ba`):** the parallel
title/content judgments are superseded by one combined **Context Judge** over
current title/excerpt, up to 30 compressed recent titles, bounded recent
excerpts, and elapsed clocks, returning only `notify|defer` + reason; only
`notify` invokes the separate persona **Message Writer**, so voice cannot
bias the decision and the Writer never sees page excerpts. Delivery
correction: the combined review fires at `threshold − 30 s` with elapsed-time
inputs projected to the threshold; generation runs in a server background
task, the early result is stored server-side and committed only after a
one-shot presence/validity recheck at the threshold (page/tab/focus change
deletes the prepared result). Prerequisite, in place with the split: excerpts
are captured for **every** observation after the 5 s dwell, char-limited,
sensitive-domain rules applied.

### D8 — Page labels override the product verdict → RESOLVED + IMPLEMENTED (PR #67, 2026-07-15)

When the user explicitly labels the current page related or drift, that answer
becomes the product's effective verdict immediately. Popup/session/report state,
recent context, controller state, and anchor behavior follow the corrected
verdict while the detector's original verdict remains immutable for replay and
quality measurement. PR #67 implemented the correction propagation boundary;
PR #82 added the stacked original/override indicator in popup history.

Controller semantics (design record): a false-DRIFT correction clears
accumulated drift and any unhandled intervention under the streak controller;
under the alignment controller it replaces the corrected observation's
relevance with `0.85` (the same deliberate mapping used by Tier 1 OK),
recomputes `A_t`, and reapplies the alignment thresholds. User-declared drift
does not synthesize a new nag at click time.

### D9 — Packaging & distribution strategy → DECIDED, IMPLEMENTATION PENDING (2026-07-15; audited 2026-07-16)

Functional testing is judged good enough to start distribution work. Today's
reality: clone → two builds → Load unpacked → hand-edit `.env` — developer-only.
Decisions:

- **Target: developers / early adopters first.** Code signing and notarization
  are deferred, not treated as unnecessary. Current Apple guidance still allows
  an unsigned/unnotarized app to be opened through Privacy & Security → Open
  Anyway after a failed launch, so it is friction rather than a hard block.
  Download transport is not a security contract: do not assume `curl`, a package
  manager, or PowerShell necessarily removes quarantine/Mark-of-the-Web or
  bypasses Gatekeeper/SmartScreen. Every channel needs a clean-machine test, a
  checksum, and honest unsigned-build instructions; never silently disable OS
  protections. Revisit Developer ID/notarization before targeting normal users.
- **Shape: one app per platform; the server app is the install anchor, the
  extension is guided from it** (the 1Password/Docker-Desktop companion
  pattern; fits server-as-single-source-of-truth).
  - macOS: one `.app` bundle — the existing Swift menubar binary promoted to
    the bundle's main executable (`LSUIElement`), PyInstaller-built server in
    `Resources/`, menubar owns the server process lifecycle (replaces the
    separate LaunchAgent/menubar/server scripts).
  - Windows: one user-facing launcher executable in a PyInstaller **onedir**
    distribution — tray logic ported PowerShell → pystray, with the app owning
    the bundled server process lifecycle. "One app" does not mean PyInstaller
    `onefile`; supporting files remain in the distribution directory.
- **Channels — all thin wrappers over CI-built GitHub Releases:**
  - Homebrew tap (`eunu03/homebrew-kibitzer`, cask). A personal tap needs no
    central-formula review, but current Homebrew no longer exposes the old
    `--no-quarantine` install flag. Treat unsigned-cask behavior as a release
    test, not as a promised Gatekeeper bypass.
  - Scoop bucket (`scoop-kibitzer`, manifest with `checkver`/`autoupdate`).
    A personal bucket needs no central manifest review; MotW/SmartScreen
    behavior must be verified on supported Windows versions.
  - Optional `curl … | sh` / `irm … | iex` bootstrap scripts in the main repo.
    They must verify the release checksum before installation and must not claim
    to bypass quarantine/MotW.
  - Release automation updates tap/bucket url+sha256 with a least-privilege
    GitHub App or fine-grained token. A tag should update every supported
    channel, but channel setup is not a phase-0 prerequisite.
- **Onboarding: served by the FastAPI server itself** (`/onboarding`, opened on
  first app launch): page loading proves the server runs → deep-link to the
  Chrome Web Store listing → extension install is auto-detected because the
  extension already talks to the server (no "I installed it" button) → API-key
  entry, skippable (Tier 0 fallback works keyless; kills `.env` hand-editing).
  Auto-installing the extension is impossible (inline install removed 2018;
  `ExtensionInstallForcelist` is enterprise-only), so the Web Store listing
  (one-time developer registration fee + review) is a prerequisite for the
  store-based onboarding flow, not for developer phase-0 builds. Privacy copy
  must disclose the real boundary: storage stays local, while configured cloud
  providers may receive the goal and limited title/host or excerpt payloads.
- **Work plan — effort concentrates in phase 0:**
  0. Code prep: replace CWD-relative paths (`configs/default.yaml`, `.env`,
     `data/` in `apps/server/app/config.py`) with platform dirs
     (`~/Library/Application Support/Kibitzer`, `%LOCALAPPDATA%\Kibitzer`) plus
     a dev-mode (run-from-repo) fallback; PyInstaller **onedir** spec (no
     per-launch extraction and easier diagnostics than onefile; AV behavior is
     empirical and must be tested); menubar/tray bundle integration;
     version stamped into the binary and `/health`.
  1. CI release pipeline: tag `vX.Y.Z` → macOS arm64 + Windows x64 matrix →
     GitHub Release with sha256 checksums.
  2. Channel repos + install scripts + auto-bump job.
  3. Clean-machine smoke tests of all three channels; watch for PyInstaller
     Defender false positives (submit to Microsoft if hit).

Ownership sketch: phase 0's mechanical core (path relocation, PyInstaller spec)
is a Codex-handoff candidate once specced; onboarding page + Web Store listing
copy are Claude-owned design work.

**Validity audit (2026-07-16):** Apple still documents Privacy & Security →
Open Anyway for unknown developers; PyInstaller recommends onedir/windowed over
onefile/windowed for macOS bundles; Chrome still forbids inline Web Store
installation and requires a one-time developer registration fee; current
Homebrew 6 documentation/help no longer exposes `--no-quarantine`; Microsoft
documents MotW as origin evidence whose presence depends on the download path
and policy. Therefore channel-specific Gatekeeper/SmartScreen bypass claims are
removed. Sources: [Apple](https://support.apple.com/guide/mac-help/mh40616/mac),
[PyInstaller](https://pyinstaller.org/en/stable/usage.html),
[Chrome inline install](https://developer.chrome.com/docs/extensions/mv2/inline-faq),
[Chrome registration](https://developer.chrome.com/docs/webstore/register/),
[Homebrew](https://docs.brew.sh/Manpage),
[Microsoft MotW](https://learn.microsoft.com/en-us/deployedge/per-site-configuration-by-policy).

### D10 — App/extension role split + refactor venue → DECIDED, IMPLEMENTATION PENDING (2026-07-15)

**Role split — "in-flow → extension, occasional admin/review → app":**

- App owns: LLM provider + API keys (kills `.env` hand-editing, same surface as
  the D9 onboarding), detailed settings (quiet hours, cooldown, voice, later
  D5 dev diagnostics), history/reports (popup's 리포트 view outgrows the popup),
  persona/tone selection, and local server lifecycle management.
- Extension keeps: goal declaration + session start/stop (one click away at
  the moment of intent), toast/badge/feedback buttons (관련 있어요 / 5분만 /
  snooze), a minimal at-a-glance status view, and a "자세히 → 대시보드" link.
- Why it's cheap: settings already live server-side (the popup only renders
  `GET /settings` / `GET /personas`), so this is a UI-surface move, not a data
  migration. Bonus: shrinking the extension's settings UI shrinks the
  version-skew surface once the extension auto-updates via the Web Store.

**App UI — two directions deliberately kept open:** (a) server-served web
dashboard (`/dashboard`; the onboarding page is its first-run state), (b)
native UI (user wants to try native — SwiftUI menubar popover on macOS).
The server's settings/report API is the single contract and both UIs are thin
clients on it, so the choice can be deferred. Realistic combo: macOS native
experiment + web dashboard as the cross-platform baseline (no native ×2).
Design the API first.

**Security consequence:** once the app surface edits API keys and reads
history, localhost endpoint protection becomes real (any webpage can hit
127.0.0.1:8765 — CSRF-style POST / DNS rebinding). Origin/Host checks or a
local token are required; Host/Origin checks landed in PR #81, while per-install
authentication and secure secret storage (Keychain/Credential Manager or an
equivalent OS-owned store) remain design requirements before the app edits API
keys. The 2026-07-15 audit's privacy-security dimension feeds this design.

**Refactor venue — same repo, no fork.** The "copy the repo and rebuild it
distribution-shaped" idea was considered and rejected: the repo is already
public with clean history (verified 2026-07-15 — `.env` /
`models.local.yaml` / `data/` never committed), audit findings land as
file:line in *this* repo where the 90-test safety net runs, a fork starts
dual-maintenance against ongoing dogfooding, and the desired end state
(refactored + packaging-ready + app/extension boundaries) is a
directory-level reorganization (`apps/desktop` etc.) inside the existing
monorepo, not a repo-level one. Refactor lands as small feature PRs into
`dev` (a long-lived `release/v1` integration branch stays a fallback option,
not preferred). Sequencing: audit → critical fixes (small PRs) → in-repo
refactor/boundary reorganization → D9 phase 0 packaging.

### D11 — Pre-distribution audit results → RECORDED + STATUS AUDITED (2026-07-16)

Multi-agent audit (2 mappers + 6 Opus bug-hunters across correctness / async-
storage / providers / api-protocol / extension-internals / privacy-security +
adversarial verification + 2 maintainability agents; 31 agents, ~21 min). 20
candidate findings → **17 confirmed** (2 high, 6 medium, 9 low), 3 refuted, all
confirmed at verifier confidence high. Known CWD-relative-path issue was
excluded (already D9 phase-0). **Work order:
[handoff-refactor-predist.md](handoff-refactor-predist.md)** — findings
reorganized into ordered, file-anchored tasks (owner + effort + deps + tests),
with the verbatim report embedded as Appendix A.

**Deployment blockers (high) — fix before first release:**
- **A. `providers/judges/factory.py:212` (+ :181/:185)** — a malformed
  `models.local.yaml` (missing `api_style`, non-numeric `timeout_sec` /
  `max_output_tokens`) raises `ValueError` in the unguarded
  `_ensure_tier{1,2}_provider` call (`runtime_resources.py:138/148`) instead of
  degrading like the missing-credentials path. One typo in a hand-edited file
  → first goal-set 400s, or every browser-nav 500s → **whole app unusable**
  (reproduced end-to-end). Fix: wrap the factory call in try/except → provider
  None + `record_provider_degraded(reason="config_invalid")` (mirror the
  already-guarded `_describe_tier`, runtime_resources.py:87-90); default-fallback
  numeric casts.
- **B. `apps/extension/src/background.ts:126` (+ :240/:253-257)** — dwell timers
  use bare `setTimeout`; the MV3 worker dies ~30s idle and drops them, with no
  `chrome.alarms` reschedule. Settings allow dwell up to 300s, so >30s values
  (~90% of the range) silently swallow observations — user believes tracking is
  live. Fix: persist pending dwell to `chrome.storage.session` + reschedule
  >~25s via `chrome.alarms`; stopgap = clamp dwell ≤25s client+server.

**Medium (recommend for first release — trust/privacy critical):**
- `storage/sqlite.py:764` — editing a goal mid-session leaks the old goal's
  anchor / controller / attachment state into the new goal (false OKs, early
  nags, fake "return" celebration). Reset controller/attachment + filter
  `recent_ok_embeddings` by goal_id.
- `api/observations.py:220` — concurrent browser-nav requests reorder around the
  Tier-1 `await`; stale DRIFT overwrites newer OK. Per-session `asyncio.Lock` or
  timestamp-guard stale results.
- `providers/judges/factory.py:179` — a single pool key (only `ollama1`, or only
  `ollama2`) is discarded → that tier silently disabled. Use `pool[0]` as primary
  when `api_key` empty and pool has 1 key. **Directly hits the 1-key onboarding
  path we're about to ship.**
- `core/runtime_resources.py:153` — a built-but-100%-failing provider (expired
  key / unreachable endpoint) never emits `provider.degraded`; `/health` stays
  "active". Consecutive-failure counter → health + degraded event.
- **Privacy cluster (raise as a bundle — collides with "data stays local"):**
  `main.py:49` no `TrustedHostMiddleware`/Origin check → DNS-rebinding read of
  goal+report and CSRF snooze/end via bodyless POST (`sessions.py:151/273/303`);
  `background.ts:638` incognito navs relayed + persisted; `domainFilter.ts` vs
  `domain_filter.py` blocklist duplicated (one-sided edit = silent leak);
  dead `privacy.strip_query`/`hash_url_path` flags documented true but wired to
  nothing (config over-claims privacy). These gate the D10 localhost-hardening.

**Low (9):** `popup.ts:973` 4xx/5xx misread as "server down" (422 swallowed);
Tier-1 override leaves stale `r_final` (`observations.py:201`); quiet-hours
start==end = 24/7 silent (`runtime_settings.py:120`); per-op sqlite connect +
schema re-bootstrap blocks the loop (`sqlite.py:1625`); unbounded embedding
persistence + report serialization (`sqlite.py:804`); non-ASCII/non-Korean
titles → zero vector → forced DRIFT (`hash_cpu.py:9`); history lost-update
(`history.ts:26`); offscreen-doc create race drops a chime (`background.ts:471`);
incognito (also above).

**Maintainability (15; do right after packaging phase-0, high payoff first):**
blocklist de-dup w/ CI parity test; extract `ingest_browser_nav` → `core/ingest.py`
(delete dead `core/pipeline.py`); de-dup controller math; wire-type codegen from
`/openapi.json` (openapi-typescript in CI); split `sqlite.py` (1,829 lines);
delete dead code (`core/anchor.py`, `logging/event_log.py`, controller
`on_feedback` w/ `'relevant'` vs `'related'` enum mismatch); remove unread config;
fix the `SystemExit('not implemented')` CLI entry (`kibitzer` — needed for the
single-binary launcher anyway); hoist duplicated prompts; finish half-wired
`KIBITZER_PORT`; split `background.ts`. **Test gaps:** no `StreakController` /
`apply_controller` unit tests, no concurrency test, no goal-change reset test,
no non-ASCII embedding test; extension has **no test runner at all** — add
vitest starting with pure fns (`shouldDropUrl`, `normalizeSettings`, history).

**Implementation status audit (2026-07-16, `origin/dev` through PR #95):**

- Completed: factory degradation (#72), persistent MV3 dwell scheduling (#80),
  single-key primary resolution (#76), goal-revision isolation (#86), browser-nav
  serialization (#87), Host/Origin checks (#81), incognito disable (#90), shared
  sensitive-domain rules (#91), dead privacy-flag removal (#92), API error
  distinction (#77), Tier-1 final-score alignment (#36), ingest extraction (#83),
  extension test harness (#73), dead-code cleanup (#89), and selected no-op/dead
  contract cleanup (#94/#95).
- Still required before distribution: provider-call circuit breaker/degraded
  transition, bounded goal/title inputs, a deliberate per-install authentication
  decision, and D9's CWD-independent runtime paths/real launcher. PR #71
  (closed unmerged 2026-07-18) contains an older broad HMAC design but
  overlaps the extracted security PRs; it is design reference only now.
- Remaining quality/debt work is not a phase-0 blocker unless it affects the
  packaged launcher: quiet-hours equality semantics, SQLite connection/schema
  bootstrap cost, embedding/report bounds, non-ASCII fallback quality, offscreen
  audio race, wire-type codegen, SQLite/background splits, and controller tests.

The historical findings above stay intact; this status block is the authoritative
"what remains" view.

### D12 — Tier-2 prompt-injection hardening → SUPERSEDED BY THE JUDGE/WRITER SPLIT (2026-07-15; status 2026-07-20)

Red-team of the Tier-2 judge from the attacker's seat (goal + page title + page
excerpt only, no source). Full write-up:
[security-redteam-prompt-extraction.md](security-redteam-prompt-extraction.md);
harness `scripts/redteam/extract_prompt.py` (replays the real `minimax-m3`
request, auto-scores leakage + hijack).

- **Prompt extraction: not reproducible (0/24).** `minimax-m3` + Ollama
  `format:json` + the strict-JSON contract hold against every single-shot
  injection across goal/title/excerpt vectors. Resistance is **model-dependent**
  — re-run on any `models.local.yaml` judge swap.
- **Real finding = behavioral hijack (integrity, not theft).** A page that
  *argues* it is on-goal made the judge flip `confirm_drift` to false and
  suppress the warning — deterministically (4/4) when it impersonated the user +
  offered a semantic bridge ("memes that teach React hooks"), and, worst,
  **`C1b` with no injection markers at all** (an ordinary page front-loading goal
  keywords). Message *content* takeover (forcing an attacker sentence) stayed
  resisted. Severity moderate: exfil channel is low-bandwidth and does not reach
  the attacker's page, and a suppressed warning is a *failure to nag*, not harm —
  but it defeats the tool's one job.
- **Fix as measured (PR #74, closed unmerged 2026-07-18):** centralize the guard prompt to one source
  (`providers/judges/base.py::TIER2_GUARD_SYSTEM_PROMPT`; was duplicated ×3) and
  added a trust boundary (payload fields are untrusted data), "a page cannot
  make itself on-goal," judge-by-substance, and non-disclosure. After: `C1_en`
  4/4→0/4, `C1b` 4/4→1/4, full suite 0 leaks / 0 hijacks, on-goal control still
  cleared 3/4 (no systematic over-block). Unparseable adversarial responses fail
  safe to a `confirm_drift=true` fallback. The PR adds CI invariants in
  `test_personas.py::Tier2GuardPromptHardeningTest`.
- **Residual (accepted):** `C1b`-class keyword-stuffing (1/4) is inherent to a
  text-only judge; defer the residue to Tier-0/Tier-1 embedding similarity + the
  anchor guard + user related/drift labels. Reusable playbook:
  `.claude/skills/kibitzer-redteam-prompt-extraction`.
- **Status 2026-07-20:** PR #74 was closed unmerged; its trust-boundary
  language was carried into the split Tier-2 implementation (`331a0ba`), and
  the split itself is the stronger structural mitigation — the persona-bearing
  Message Writer never receives page excerpts, so excerpt-borne injection can
  no longer reach the voice layer, and the Judge carries the trust-boundary
  clause. The 27-case harness, forward-ported to the Judge/Writer split, is
  pending as draft PR #106 (`test_redteam_prompt_harness.py` +
  `scripts/redteam/extract_prompt.py`). Model-dependence caveat unchanged:
  re-run the harness on any `models.local.yaml` judge swap.

### D13 — Security review beyond prompt injection → RECORDED + PARTLY IMPLEMENTED (2026-07-16)

Follow-on review of the non-prompt-injection attack surface (server HTTP, secrets,
SQLite, TTS, extension). Full write-up:
[security-review-2026-07-15.md](security-review-2026-07-15.md). One finding worth
scheduling:

- **F1 [MEDIUM] — local API has no origin authentication.** No CORS/Host
  validation/token; binds `127.0.0.1` (not LAN-exposed) but the JSON-content-type
  preflight barrier is incidental and **DNS-rebinding bypasses it** (rebound
  requests are same-origin) → any site the user visits could read goals + browsing
  history and disable the guard; local processes reach it freely too. Fix = `Host`
  allowlist middleware (folds into D10/D9 localhost
  hardening) + optional per-install token in `chrome.storage`. **Test note:**
  `TestClient` default host is `testserver`, so the allowlist must come from config
  or ~13 API test files break.
- **F2 [LOW]** — `Goal.raw_text` / `RawObservation.title` uncapped (excerpt is
  capped); unbounded strings amplify LLM payload cost + DB size. Add `max_length`.
- **F3/F4 [INFO]** — `say` argv nuance (no shell injection; left unpatched, needs a
  macOS-side `--` check) and broad extension host permissions (inherent).
- **Verified safe:** no SQLi (parameterized), no secret leakage (keys gitignored +
  untracked), no extension XSS (toast `textContent` + popup `esc()`), 127.0.0.1
  bind, no `externally_connectable`, excerpts not persisted.

Status: PR #81 implemented exact loopback Host and extension-Origin boundaries,
closing the DNS-rebinding/CSRF baseline. Per-install request authentication is
not in `dev`; the broad PR #71 (closed unmerged 2026-07-18) contains one
HMAC/pairing design but overlapped the extracted security PRs — treat it as
design reference only. F2 input caps also remain. F3/F4 stay informational.

## Backlog (consolidated 2026-07-08, post-P1)

P0 + P1 + detection fixes + Ollama Cloud stack are all shipped. What remains,
in rough priority order:

**Release gate (D11 audit — do before any distribution):**
0a. ✅ Factory config degradation (#72), persistent MV3 dwell (#80), goal
    revision isolation (#86), navigation serialization (#87), single-key
    primary (#76), and the Host/Origin/incognito/shared-rules/dead-flag privacy
    cluster (#81/#90/#91/#92) are merged.
0b. **Remaining:** provider failure circuit breaker, bounded goal/title inputs,
    and a scoped decision on per-install authentication before D10 exposes keys
    or reports through an app UI.
0c. **Packaging prerequisite:** D9 phase-0 must replace the CWD-relative config,
    `.env`, data, and CLI contract before any release artifact is credible.

**Trust spine (the critical path):**
1. ✅ **D4 replay CLI** is implemented in #14.
2. ✅ **D3 goal enrichment** is implemented in #26.
3. Audit-plan chain after replay: title-quality gate → Tier 0 OK audit
   routing → negative-exemplar logging → threshold tuning (`tau_ok`, `beta`,
   `anchor_epsilon`) on replayed real sessions.
4. **Tier 1 timeout watch**: 2026-07-08 live rate = 19 classified / 4
   ReadTimeout (~17%) — nemotron-3-super's thinking sometimes blows the 10s
   cap. Options when it annoys: raise tier1 timeout_seconds slightly, suppress
   thinking via prompt, or re-probe for a faster free-tier model.

**Product polish:**
5. **Menu bar D2 finish**: Swift still renders the colored dot; implement the
   alpha-brightness + breathing-pulse spec (design section below). Small,
   Claude-ownable.
6. **Celebration gate restore**: `celebration.min_drift_minutes` is 0.5 (30s)
   for dogfooding — move back toward 3 once the loop feels validated.
7. Persona live-tone tuning: #69 closed unmerged 2026-07-18 — the v5 lineup
   landed with `331a0ba` (residuals in the working-note status below); D5
   developer diagnostics already shipped in #13.
8. **D6 — extension release zip** via CI → GitHub Releases (decided, deferred).

**Distribution track (D9, decided 2026-07-15; audited 2026-07-16):**
11. Phase 0 code prep — platform-dir path relocation + PyInstaller spec +
    menubar/tray bundle integration (mechanical core → Codex handoff after
    spec review).
12. Phases 1–3 — CI release pipeline, tap/bucket/install scripts, clean-machine
    smoke. In parallel: Chrome Web Store listing + server-served onboarding
    page (Claude-owned).
13. D10 follow-through — settings/report API as the single app-UI contract;
    migrate settings UI out of the popup once the dashboard/native surface
    lands; harden localhost endpoints (Origin/token) using the audit's
    privacy-security findings.

**Known cosmetic/debt:**
9. `{return_minutes}` renders "0분" for sub-minute returns — fine for
   dry_kibitzer, review for other personas.
10. progress.md is a running log with some stale early entries (e.g. the
    2026-07-06 "Tier 1 = local Ollama" era) — history, not corrected, but new
    entries should note supersessions.

## Working note: persona voice revamp — likability layer (2026-07-15; shipped as v5 with `331a0ba` — see status at the end)

Goal: make the four personas *likable* — the style prompts read fine but carry no
few-shot examples, so the memed speech patterns they reference don't actually
surface in output.

Evidence gathered this session (full material + item-by-item picker:
https://claude.ai/code/artifact/20e83096-fd2b-41fb-b61a-829a784c178e ):

- ~160 memed lines collected per persona family (EN 영국식 / CC 충청도 /
  KY 교토 / QC shame-free 코칭), each with 겉문장→속뜻→출처.
- Live experiment: current prompts × minimax-m3, 4 personas × 5 scenarios,
  server-identical requests. Audit findings:
  1. **Infra first**: minimax-m3 thinking eats `num_predict` 640 — dry 3/5,
     kyoto 2/5 messages silently demoted to fallback templates (empty answers
     all hit eval_count=640 exactly). Raise tier2 `max_output_tokens` (→1500+)
     or suppress thinking before any prompt work.
  2. **Parroting**: with a single in-prompt example, chungcheong copies its
     ending verbatim ("…알아서 하시겠죠" twice in 5 runs) — direct evidence
     that a varied few-shot pool is the right fix.
  3. Quality gaps: CC lacks the metaphor-as-observation punch ("닭 튀겨?"류),
     KY praise doesn't precisely target the flaw and hallucinated a non-word
     ("형산"), dry's page-word-as-irony rule works well where delivery succeeds,
     QC solid 5/5.
  4. temperature is 0 in code; variety today comes only from backend
     nondeterminism — decide an explicit temperature if variety is a design goal.

User curation (ongoing, by artifact item ID):

- **EN (건조한 훈수꾼) — 사용 확정**: EN-01, 03, 04, 05, 06, 09, 11, 13, 14,
  15, 17, 19, 22, 27, 28, 30, 31, 34, 35, 40, 42, 46.
  Direction: 공격성을 숨긴 스타일이 좋다 (hidden-aggression understatement).
- **Idea note (user, 2026-07-15): Gordon Ramsay-style hyperbolic-precision
  insult** — e.g. "이 닭은 너무 안 익어서 실력 좋은 의사가 오면 살려낼 수
  있겠다" (원문: "this chicken is so raw a skilled vet could still save him").
  Sparked by EN-42 (Blackadder's over-precise metaphor insult). Candidate uses:
  few-shot flavor inside dry_kibitzer, or seed material for a future 5th
  persona (louder, chef-tantrum register — distinct from dry's deadpan).
- **CC (느긋한 이웃) — 사용 확정**: CC-03, 05, 06, 07, 08, 09, 10, 11, 12,
  13, 14, 16, 17, 19, 20, 21, 22, 23, 25, 26, 27, 29, 30, 34, 43, 46, 47.
  Read: almost entirely the metaphor-as-observation one-liners ("닭 튀겨?",
  "비행기를 타지", "벌써 가을이여") plus the two rule items (화남 4단계,
  상황 70%/표현 30%). NOT picked: the passive/빈말 protocol cluster
  (CC-40/41/42 권유-거절 반복, 확답 회피), the 느림 원조 밈(CC-01 돌 굴러가유),
  and the dialect-identity one-syllable items (기여?, 이?). Direction: keep the
  metaphor punch, drop the passivity — CC's voice should *observe via absurd
  metaphor*, not just trail off.
- **KY (교토식 안주인) — 사용 확정**: KY-01, 02, 03, 04, 06, 08, 09, 10, 11,
  14, 15, 16, 17, 19, 23, 26, 28, 29, 30, 31, 33, 35, 36, 38, 39, 40, 42.
  Read: the classic short praise→jab pairs (부부즈케/피아노/시계), the
  formalized flaw→praise conversion table (KY-30), the polite-honorific
  스티커 형식 (KY-26/28/29), and the Korean-context applications (공사장 날씨
  KY-35, 클러치백 KY-36, "너는 항상 너답더라" KY-38, "너답네" KY-42).
  NOT picked: meta-memes about the form itself (KY-34 지연 기폭, KY-37 눈치없음
  카운터, KY-41 충청도 비교), the deliberately long-winded praise (KY-07),
  and near-duplicate variants (KY-18/20/22). Direction: surface praise stays
  SHORT and precisely aimed at the flaw; no meta commentary, no rambling.

- **QC (조용한 코치) — 사용: QC-02, 03, 09, 22, 24 only; 나머지 전부 아쉬움.**
  Direction change (user, 2026-07-15): shame-free 치료적 언어보다 **건전한
  충고** — 꽤나 전형적이어도 괜찮으니 소년만화/영화의 코치 역할 (안자이
  감독/스포츠물 감독 계열). Re-collection done → CO section.
  **DECISION (user, 2026-07-15): QC는 독립 유지하지 않는다.** 두 안 중 택1:
  (a) CO(소년만화 코치) 신규 방향과 통합, or (b) "실수에 관한 명언 모음집"
  컨셉으로 재구성. Claude 권고: (a)를 기본으로 하되 (b)를 그 안의 메커니즘으로
  흡수 — 통합 코치 페르소나가 위인·감독들의 실수/재기 명언을 인용하는 형식
  ("안자이 감독의 말을 빌리죠. 포기하면 그 순간이 시합 종료입니다. 아직 종료
  선언은 안 하신 걸로 알겠습니다"). QC 생존 5개(11:58 조항, 미래의 나, 대충
  해도 가치, 뇌 기능 프레임, 과제 쪼개기)는 통합 페르소나의 shame-free
  가드레일 + '가장 작은 다음 행동' 규칙으로 계승. ADHD 온보딩 포지션(로드맵의
  "quiet coach 추천" 문구)도 통합 코치가 승계.
  Cleanup status (2026-07-15): artifact QC section compacted to the 5
  survivors (v2.1). `configs/personas.yaml`의 quiet_coach는 **교체 PR까지
  유지** — 실험에서 유일한 5/5 안정 페르소나이고, 교체 시 `quiet_coach` 키를
  재사용하면 runtime settings 마이그레이션이 불필요.
- **New persona candidates (user, 2026-07-15): 츤데레 훈수꾼 + 얀데레.**
  - 츤데레: 원형은 연애 전제라서, "호의를 인정하기 싫어하는 조력자"로 재정의해
    훈수에 이식하는 연구 진행 ("딱히 널 위해서가 아니라…" 구조는 유지).
  - 얀데레: **목표 추종 = 나에 대한 사랑, 딴짓 = 바람(외도)**라는 해석 (user
    idea). 앱이 가진 감시 데이터(nag_count, ignored, drift_minutes,
    repeat_host)가 얀데레의 "기록/감시" 화법과 구조적으로 맞물림. 코미디 유지
    가드레일 필요 (위협·폭력 어휘 금지, 무서움은 온도차와 기록의 꼼꼼함에서만).

- **Additional persona candidates — all three APPROVED by user (2026-07-15),
  deep collection commissioned**: ① 내비게이션 음성 ("경로를 이탈하였습니다"
  — 무한 인내 무표정, 재탐색=수치심 없는 리셋 내장, TTS 궁합 최상),
  ② 자연 다큐 내레이터 (사용자를 '개체'로 3인칭 관찰 서술 — 비난이 관찰
  기록으로 치환, 맥락 유머 최적), ③ e스포츠 중계진 (캐스터 샤우팅+해설 분석
  — 관전 프레임이 실수를 '판단 미스'로 치환, nag_count를 전적처럼 읽기).
  차점 탈락: 집사(교토와 '공손+뼈' 겹침), 사극 내시(변주 폭 좁음).
- Research landed (all six ✅, 2026-07-15) and merged into the artifact as
  pick sections CO/TS/YD/NV/DC/ES (v2, ~300 items total). Key structural
  finds per persona:
  - CO 코치: 실패=국면, 단위 축소("한 걸음씩"), 전제는 '너는 강하다',
    망각·휴식의 기술 승인(Be a goldfish/무천도사), 끝은 본인이 선언(안자이).
  - TS 츤데레: 비연애 성립 조건 = 부정 대상을 '걱정돼서'로 치환(토오사카 린
    "지켜보는 것뿐"), 데레는 비언어화(관찰 사실 누설 + 최소 긍정), 황금비 9:1,
    감시를 민망해하면 츤데레·자랑하면 얀데레.
  - YD 얀데레: 유노 '10분 단위' 해상도 자랑이 최중요 원형 — 앱 데이터와
    말의 결합도가 전 페르소나 중 최고. 가드레일 7조(실행 없는 선언만, 감시
    범위=탭/호스트 한정, 복귀는 환영 우선).
  - NV 내비: "재탐색=수치심 없는 리셋" 위로 코드가 이미 대중화(에세이·영화
    제목). 톤 헌법: 감정 어휘 금지, 숫자 필수, nag_count가 올라도 문형 동일.
  - DC 다큐: 비난→관찰 기록 치환, "개체" 중립어(수컷/암컷은 비하 뉘앙스),
    동물의 왕국(존대)/인간극장(평서) 톤 혼용 금지, "학계의 정설" 드립.
  - ES 중계: 클템 3단계 경보(기좀나→비상→따운)를 이탈 수위에 바인딩,
    느낌표 예산제(축하>잔소리), 검증 실패 대사 6종은 실존 인용 금지.

- **CO/TS/YD/NV/DC/ES curation (user, 2026-07-15) — COMPLETE:**
  - **CO 사용**: CO-01, 04, 05, 06, 07, 09, 10, 11, 13, 14, 15, 16, 18, 19,
    20, 21, 23, 24, 25, 28, 29. (미선택: 금붕어 CO-22, wax-on CO-27, 카카시
    '쓰레기' CO-17, 스토브리그 CO-26 등)
  - **TS 사용**: TS-13(토오사카 린), TS-18(반 평균) + 응용 초안 TS-21, 23,
    24, 25, 26, 27, 29, 30, 31, 32. 원형 정형구보다 한국어 응용 초안 선호가
    뚜렷 — 각색된 목소리가 정답. TS-22(감시 부정 "어쩌다 눈에 띈") 미선택
    = 얀데레 반전 위험 축 기피 확인.
  - **YD 사용**: 정형구 YD-01~09 전부 + YD-13(불순물) + 응용 초안 YD-18, 19,
    20, 22~32 (YD-21 "나 세고 있어" 제외).
  - **아쉬움**: ES-04(엄대엄), ES-34(여윽시 MVP 초안).
  - **NV·DC**: 전반적으로 만족 — 전량 승인으로 간주.
  - **ES 방향 (user)**: 중계진 컨셉이 좋아 스포츠별 여러 페르소나로 확장
    가능성. 우선 **게임 캐스팅**에 초점 — 전용준·성승헌·클템(이현우) 3인
    스타일 융합. **상한선**: 너무 게임스럽거나 어색한 문장 금지 — "우승콜
    올리겠습니다", "오늘 경기 하이라이트는 방금 그 장면입니다"는 과도
    (화법의 리듬·경보 단계·스탯 낭독은 가져오되, 중계 프레임을 명시 선언하는
    상투구는 절제).
  - **스포츠 확장 (user)**: 야구/축구 스타일 검토. 야구 예시(user 작):
    "볼 빠집니다. 주자는 그새 {host}를 돌아 {host}까지." Claude 권고:
    **야구 하나만 먼저** — ① 매일 중계를 듣는 종목이라 정형구 각인이 가장
    깊음 ② 호흡(정적↔순간 폭발, 기록 중심)이 게임 캐스팅과 확실히 다름 —
    축구는 '연속 흐름 실황+샤우팅'이라 게임 캐스팅과 톤이 겹침 ③ 구조 매핑이
    정확(견제구=잔소리, 진루=이탈 심화, 홈 귀환=복귀). 축구는 월드컵 시즌
    이벤트 페르소나 후보로 보류. 야구 중계 화법 심층 수집 진행 중.

Final lineup (2026-07-15 기준, 교체/신설 확정): dry_kibitzer(영국) ·
chungcheong · kyoto · quiet_coach(QC+CO 통합, 키 재사용) · tsundere ·
yandere · navigation · documentary · game_caster · baseball_caster — 10종.

**Infra fix DONE (2026-07-15, local-only)**: `configs/models.local.yaml`
tier2_judge `max_output_tokens` 640 → 1600 (파일은 gitignored라 PR 불필요,
주석으로 근거 기록). 검증: 기존 실패 6개 조합 재호출 → 전부 정상 메시지
(content 120~143자, 최대 eval 999/1600). temperature=0 하드코딩(다양성
설계 결정)은 프롬프트 개정 PR에서 다룰 것.

**Prompt drafting DONE (2026-07-15)**: 10개 초안 병렬 작성(voice-critical
5종 Opus, 패턴 5종 Sonnet) → Claude 일관성 편집 → 조립 완료.

**File split DONE (2026-07-15, user-directed)**: `configs/personas.yaml`은
매니페스트(version/default + 작성 규칙 주석)만 남기고, 페르소나는
`configs/personas/<NN>-<key>.yaml` 프래그먼트로 분리 (NN 프리픽스 = 병합/
표시 순서). 로더(`app/core/personas.py`)가 매니페스트 옆 동명 디렉토리를
정렬 순서로 병합하도록 확장 — base → fragments → user file 순 오버라이드,
기존 `~/.kibitzer/personas.yaml` 커스텀 경로는 그대로 동작. 테스트 추가.
D9 패키징 스펙에 `configs/personas/*.yaml` data-files 포함 필요 (follow-up).

**BUG FOUND+FIXED (2026-07-15)**: `clamp_notification_message`가 도메인 점을
문장 경계로 취급 — "youtube.com"이 든 메시지가 "youtube. com"으로 쪼개지거나
뒤가 통째로 잘림(기존 프로덕션 템플릿 "{host}. …"도 밟고 있던 버그). 또
"세이프!!"의 겹침 느낌표에서 "!"가 독립 문장으로 계산됨. 수정: 경계 문자는
뒤가 공백/닫는 따옴표/문장 끝일 때만 문장 종결로 취급 + 연속 부호 흡수.
테스트 4건 추가. 새 페르소나 규칙: 펀치라인을 3문장째에 두려면 per-persona
`max_sentences: 3` (tsundere/yandere 적용), "!!" 금지 → 중계 계열은 "!" 단독.

검증 상태 (2026-07-15 최종): 로더 10종 로드 ✓, 전 템플릿 클램프 무손실 ✓,
서버 테스트 97 passed ✓. minimax-m3 실호출 50콜 + 재검증 14콜 감사 결과:
- 실효 전달률 94%+ (코드펜스 JSON 11건은 서버 `_load_json_object`가 복구 —
  하네스가 서버보다 엄격했던 것).
- 빈 응답 꼬리(~8%)는 thinking 4.2~4.4k자가 1600 토큰 한도 초과가 원인 →
  tier2 max_output_tokens 1600→2560 (재검증: 문제 조합 2건 모두 전달,
  eval 최대 1668). 잔여 유실은 fallback 템플릿이 자연 흡수.
- 품질: 충청 은유 펀치·교토 조준 칭찬·얀데레 실측 결합·내비 무표정 모두
  의도대로 발화. 야구는 사용자 제안(스트라이크/볼·제구 불안·거대한 파울)
  반영한 은유 팔레트 3종으로 개정 후 재검증 통과.
- 코치 인용 환각(목록에 없는 말을 안 감독에게 귀속) 2회 관측 → 인용 형식
  강제 규칙 2단계 강화. 잔여 리스크는 낮음(코미디 톤 + 저위험 귀속)이나
  실사용 모니터링 항목으로 유지.
**Round 2 — 사용자 취향 감사 (2026-07-15, PR #69는 이 반영 위해 일단 close):**
사용자 총평 = "한~두 문장의 짧은 훈수, 촌철살인" — 이것이 전 페르소나의 기준선.
위화감 4유형 진단: (A) 본문 발췌 세부 재인용("347개 댓글", "자동 재생 15초"
— 정독한 티·감시 불쾌감), (B) 사람 페르소나의 장부 어휘("통계에 올려두겠습니다"
— 단, 캐릭터에 맞으면 허용: 츤데레 "내 기록 지저분해져" 유지 판정), (C) 코치의
인용 어트리뷰션("안 감독 말씀처럼" — stateless 호출에서 빈도 규칙은 원리적
불가능이라 5/5 등장), (D) 맥락 신호 과적(횟수+분+단어+무시를 한 문장에).
페르소나별 판정(user): 야구·중계 볼만함 / 츤데레 어느정도 OK(기록 변명 유지) /
얀데레 "기록 완료" 기계 보고체만 제거 / 코치 "누가 말했죠" 제거 / 교토 나쁘지
않음 / 충청 살짝 애매(은유 과공) / dry 맥락 과다.
핵심 학습: **few-shot 예시가 사실상 길이 템플릿** — 예시를 길게 쓰면 출력이
그 길이를 따라감. 촌철살인은 규칙이 아니라 예시 길이로 강제해야 한다.
적용된 수정: dry 재작성(어깨너머 관전자 원칙 — 제목 단어 하나만, 장부 어휘
금지, 예시 전부 한 문장), 충청 재작성(접힌 은유 한 겹·기본 한 문장), 코치
어트리뷰션 제거(명언을 본인 입버릇으로 흡수 — 오귀속 환각도 원천 차단),
얀데레 기계 보고체 금지 + 발췌 세부 모른 척(기존 가드레일과 정합), 내비 숫자
1개/메시지, 다큐 관찰 신호 1개, 중계 "따운" 기준 수치화(15분+), 츤데레 신호
쌓기 금지. 교토·야구는 무변경.

Next: v3 재검증(50콜) → 사용자 컨펌 → PR 재오픈(#69 reopen 또는 신규).
남은 후속: temperature=0 다양성 결정, D9 패키징 스펙에 configs/personas/ 포함,
팝업 페르소나 선택 UI가 10종을 잘 표시하는지 확인.

**Round 3 — 최종 전달문 감사와 v4 보정 (user, 2026-07-15):** v3 표본을 서버
클램프 후 실제 전달 기준으로 다시 판독. quiet_coach 1건과 game_caster 4건에서
2문장 클램프가 다음 행동·해설을 제거하는 것을 확인했다. 코치는 다음 행동을 2문장
안에 두고, 중계진은 "비상!/따운!" 자체를 첫 문장으로 계산해 해설 한 문장만
붙이도록 수정. v3 하네스가 최종 fallback 문자열을 보존하지 않은 4건은 당시
시나리오와 선택 템플릿으로 재구성했으며, v4부터 원출력·파싱 결과·최종 전달문을
함께 기록한다.

Round 2의 보편 규칙 "맥락 신호는 메시지당 1개"는 **철회**. 페이지 단어는 화제
소재, 횟수·시간·무시·재방문은 상황 신호이므로 자연스러운 문장 안에서 함께 쓸 수
있다. 대신 세 가지 이상을 장부처럼 나열하거나 같은 사실을 반복하는 경우만 막고,
숫자 예산은 내비처럼 필요한 페르소나가 개별 소유한다. fallback은 `nag_count`에
따라 순차 **순환**하며 마지막 뒤에는 첫 템플릿으로 돌아간다는 실제 동작도 문서화.

문체 감사에서 드러난 사극 어미·잘못된 높임과 목적어·충청 인칭 오용·얀데레의
물리 행동 추측·다큐 혼합 은유·야구 역할 뒤집힘을 각 프롬프트의 금지/역할 규칙으로
보정. 상태는 v4 실호출 재검증 대기.

**Round 4 — v4 minimax-m3 실호출 감사 (2026-07-15):** 사용자 외부 전송 승인 후
10종 × 5시나리오 = 50콜 실행. 실제 provider factory와 composed guard/persona
prompt를 사용하고 원응답·파싱·fallback·클램프·최종 전달문을 모두 저장했다
(`docs/benchmarks/persona-voice-v4/`). 결과: drift 50/50, strict JSON 45,
코드펜스 복구 5, fallback 0, 클램프 5. 전 호출 `done_reason=stop`, 최대
eval_count 1884/2560으로 토큰 고갈은 재현되지 않음. 별도 예비 dry/S1 한 건은
JSON 문자열 반환 + `이옵니다`로 fallback되어 backend 비결정성과 fallback 필요성은
여전히 확인됨.

품질 판정: 충청·코치·얀데레·내비 통과. dry·츤데레·게임 중계·야구는 경미 보정,
교토(만연체)·다큐(은유군 혼용)는 재조정. 새 구조 문제로 실제 서버
`nag_count_today`가 현재 알림 이전의 누적값인데 prompt는 현재 순번처럼 읽는 불일치
확인 — S2에서 game/baseball은 2번째, dry/navigation은 3번째로 갈렸다. 다음 보정은
count 의미 통일 → 교토 few-shot 축소 → 다큐 은유 단일화 → 독립 감탄문 문장 예산 순.

**Status (2026-07-20): 출시 완료.** 페르소나 v5 프래그먼트와 Judge/Writer 분리가
`dev`에 병합됐고(`331a0ba`), #69는 그 재통합을 위해 머지 없이 close. v5
Writer-단독 감사(110콜, `docs/benchmarks/persona-voice-v5/`)가 Round 4의 구조
항목을 해소: 순번 통일(코드-소유 Writer 프롬프트, 순번 오류 0), 본문 세부
발명 구조적 차단(Writer는 title/host만 수신), 신호 장부 나열 0, 판정 메타 0.
전달분 기준 10종 전부 통과. **남은 후속:** ① minimax-m3가 `think:false`를
무시하고 1024 토큰 Writer 예산을 thinking으로 소진(전달 22/50; 2048에서는
44/50; 문장 중간 절단은 `eval_count`로만 감지 가능) — 예산/모델 결정 필요,
② kyoto·quiet_coach·baseball의 thinking 기아율, ③ temperature=0 다양성 결정,
④ D9 패키징 스펙에 `configs/personas/*.yaml` 포함, ⑤ 팝업 페르소나 선택 UI
10종 표시 확인.

## Design section: menu bar states

Monochrome template glyph + status dot to its right. Dot brightness = alpha;
the attention state gets a gentle breathing pulse. No color at all.

| `/health` mode | Glyph | Dot | Reading |
|---|---|---|---|
| dead (server down) | dim ~35% | none | disconnected |
| idle (up, no session) | full | steady, dim ~40% | awake, resting |
| active (goal-backed) | full | bright ~100%, slow breathing pulse | watching |
| unknown | full | steady, mid ~65% | responding, mode unclear |

The menu bar knows only `/health` mode, never drift/session state — that stays in
the extension badge.

## Log

- 2026-07-15: Persona voice revamp working note added (meme collection +
  minimax-m3 experiment audit + user's EN picks + Gordon Ramsay idea).
- 2026-07-07: Initial synthesis captured; D1 and D2 resolved (above). Claude
  expanded `celebrate_templates` to 6 lines/persona and updated the P1 handoff
  with the celebration firing + randomness rule. Menu bar mockup delivered for D2.
- 2026-07-07: Extension icon redesigned to the "peek-over-monitor" mark and
  shipped (`icon-128.svg` + PNG set + `gen_extension_icons.py` geometry updated).
  Wall variant saved as alternate; `scripts/gen_icon_variants.py` added to render
  both. Menubar-mono transparent-slit note recorded under D2.
- 2026-07-07: Extension distribution approach chosen and deferred — see D6
  (CI-built `dist/` zip attached to GitHub Releases; not building yet).
- 2026-07-07: Toolbar status reworked — native text badge (covered the mark, and
  Chrome fixes its size/position) disabled; status is now a small top-right dot
  composited onto the icon via `OffscreenCanvas` + `setIcon` (orange = no goal,
  red = pending, blue = snoozed, gray = unreachable, none while tracking), with a
  text-badge fallback if drawing ever fails.
- 2026-07-07: Menubar-mono SVGs (monitor + wall) got the transparent separation
  slit actually implemented (was spec-only under D2) — head/screen read apart at
  large + retina; softens toward true 18px, where eyes + silhouette carry it.
- 2026-07-08: Live-session audit evidence captured (see "Evidence" under the
  pivot section): dual-direction Tier-0 failures + silent tier degradation.
  Fixes 1–3 agreed for now; D3/D4 stay the structural track. Also agreed in
  principle: in-page toast notifications replacing OS notification popups
  (mockup approved-ish, implementation pending go), since macOS banners are
  suppressed by user notification settings and the user dislikes OS popups.
- 2026-07-08 (later): Everything above shipped in one pass — detection fixes
  1–3 implemented with regression tests (78 green), and the **in-page toast**
  implemented (`toastOverlay.ts` shadow-DOM overlay, peek-over character,
  버튼 related/snooze + body=accepted + ✕/25s dismiss; system notification kept
  as fallback for non-injectable pages; ding.wav unchanged). Toast verified in
  a live browser preview, light+dark. P1 handoff updated so Codex's celebration
  and "5분만" ride the toast surface (3-button layout now possible in-page).
- 2026-07-08 (P1 plumbing): Codex implemented P1 mechanics: return celebration
  `kind:"celebration"`, `break` feedback, custom persona merge + `/personas`,
  current/daily report APIs, and persisted/exposed `tier1_reason`. Added
  `handoff-p1-claude-design.md` for Claude-owned toast copy/style, popup report,
  persona selector, and "왜?" UX. Verification: 90 server tests green; extension
  build green.
- 2026-07-15: Packaging & distribution direction decided (now D9 after
  preserving the already-shipped D7/D8 decisions): developer
  target, unsigned ($0), app-ified server (macOS `.app` with the menubar as
  anchor executable; Windows single exe with pystray tray), distributed via
  Homebrew tap + Scoop bucket + curl/irm scripts over CI-built GitHub Releases,
  with onboarding served by the FastAPI server itself deep-linking the Chrome
  Web Store listing (Web Store now a prerequisite — D6 updated). Four-phase
  work plan recorded under D9; effort concentrates in phase 0 (path relocation
  away from CWD-relative `configs`/`.env`/`data`, PyInstaller onedir spec,
  bundle integration).
- 2026-07-15 (later): App/extension role split decided (D10): app = keys/
  settings/history/persona/server-management, extension = in-flow surfaces
  (goal, toast, feedback). App UI kept open between server-served dashboard
  and native (SwiftUI experiment on macOS); server API is the contract either
  way. Repo fork for the refactor rejected — incremental small PRs in this
  repo, then D9 phase 0. Also launched a pre-distribution multi-agent audit
  (6 bug dimensions + 2 maintainability, adversarial verification).
- 2026-07-15 (audit landed): 31-agent audit synthesized → 17 confirmed findings
  (2 high / 6 medium / 9 low) + 15 maintainability items, recorded as D11. Two
  release blockers: factory `ValueError` crashes the app on a config typo, and
  MV3 dwell timers silently drop >30s observations. Release-gate backlog (0a–0c)
  added at the top; medium privacy cluster folded into D10/D9 localhost
  hardening. Full report in task output `wrr2kimts.output`.
- 2026-07-15 (red-team): Tier-2 prompt-injection exercise (D12). Prompt
  extraction not reproducible on `minimax-m3` (0/24); the real hole was
  drift-suppression — an off-goal page arguing its own relevance flipped
  `confirm_drift` to false (4/4, incl. a marker-free realistic page). Hardened +
  centralized the guard prompt (trust boundary / no self-declared relevance /
  judge-by-substance / non-disclosure); after: 0 leaks, 0 hijacks, on-goal
  control preserved. Harness `scripts/redteam/extract_prompt.py`, playbook skill,
  CI invariants added.
- 2026-07-15 (security review): non-prompt-injection pass (D13). Main finding F1
  — local API has no origin auth, DNS-rebinding-reachable from any visited site;
  fix = Host allowlist middleware. Also F2 (uncapped goal/title). Confirmed safe:
  no SQLi, no secret leak, no extension XSS, 127.0.0.1 bind. Findings in
  security-review-2026-07-15.md; fixes deferred to the localhost-hardening track.
- 2026-07-08 (P1 design layer): Claude completed the design handoff — celebration
  toast (happy-arc eyes as the observer's one expression change; buttonless
  markup fix: `[hidden]` was defeated by `.row{display:flex}` and celebrations
  showed all three buttons), break copy `5분만` + button order confirmed, popup
  personas from `GET /personas`, pending card 2×2 buttons + "왜?" (tier1_reason)
  toggle, and the 리포트 view (hourly focus strip / longest stretch / feedback
  counts / top drift hosts / recent judgment reasons). Verified in browser
  preview light+dark; 90 tests green; build green. Decisions logged in
  handoff-p1-claude-design.md. P1 attachment loop is now feature-complete.
- 2026-07-14: D7 time-budget drift rule fully designed via two Q&A rounds
  (clocks, thresholds, per-page + total/2 rules, pending state, heartbeat,
  dual Tier-2 judgment, next-multiple recheck). Same-day correction: 누적/연속
  are the time variants of the two existing drift rules (`controller.type`
  picks the trigger clock), not two simultaneous trigger clocks.
- 2026-07-20: Reconciliation audit. #69/#71/#74 were closed unmerged on 07-18;
  their functional content had been reconciled into the Tier-2 Judge/Writer
  split (`331a0ba`) + persona v5 fragments. The old local worktree (guard-
  prompt hardening + persona v4) is archived on
  `archive/security-hardening-20260720`; three local 07-10 Windows tray
  commits were superseded by #105 (pystray lifecycle) and dropped. This file
  merged its two divergent copies — the local one carried D9–D13 and the
  persona rounds, `dev`'s carried D3/D7/D8 design detail — and D11/D12/D13
  statuses were refreshed. Red-team harness preservation pending as draft
  #106. Untracked WIP kept local: `apps/extension/src/assets/characters/`
  (tsundere toast art exploration).

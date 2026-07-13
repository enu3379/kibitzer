# Planning Notes — Claude ↔ User

Living working doc. Unlike `progress.md` (a log of completed work) and
`roadmap-fun-layer.md` (the master product plan), this file is where Claude and
the user think out loud and record decisions as they are made. Edit freely from
both sides; keep the "Open decisions" statuses current.

Last updated: 2026-07-08.

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

### D3 — Goal-enrichment LLM call → RESOLVED (design, 2026-07-09)

The audit plan adds one cheap LLM call at goal declaration to derive positive
goal phrases. Only the goal text leaves the call site; no page content.
Direction update (2026-07-08, user): the stack runs on **Ollama Cloud** (tiers
use nemotron-3-super / minimax-m3 there — newest free-tier models by live probe) — drop the local-first framing; the
enrichment call should ride the same Tier 1 cloud provider. OPEN only on
prompt/shape, not on where it runs.

**Data-driven requirement (Step 0, 2026-07-08):** enrichment MUST produce
**cross-lingual phrases (Korean + English)** and sub-topic vocabulary. The
private labeled replay corpus shows the dominant Tier-0 failure is false-DRIFT
(80/142 related pages under τ), mostly Korean goal ↔ English page titles
(r0=0.000 for "How To Make a Train In Minecraft Create Mod!" under
"마인크래프트 크리에이트모드") plus unreachable sub-topic words (압출기,
배낭 펌프, 서비스센터). Threshold tuning cannot fix a 0.00-mass. The corpus
stays local because it contains browsing history; set `KIBITZER_AUDIT_CORPUS`
to rerun its regression test.

**Design resolved 2026-07-09 → `handoff-goal-enrichment.md`.** Key shape:
one async call at goal declaration (Tier-1 cloud stack, goal text only),
K≤8 phrases via a strict prompt (no bare platform/generic words, ~half
English when the topic lives in English), stored as a separate
`goal_derived_exemplars` table, and matched at a **separate higher
threshold `derived_tau=0.25`** — the user's false-OK concern, answered
empirically: at 0.25 the pre-flight eval keeps 52/55 fixed false-DRIFTs
while cutting new false-OKs 7→2, both of which sit inside the 0.35 audit
band (hash-bucket noise is why the union of K phrases needs its own bar).
**User proposal (2026-07-09, adopted as feature 2): the derived phrases
also ride the Tier 1 payload** ("these vocabularies match this goal"), so
the judge gets the same cross-lingual bridge for exactly the borderline
band Tier 0 can't settle. Acceptance = deterministic private-corpus regression
(`--derived-phrases` injection): false-DRIFT ≤ 30 of 80, new false-OKs all
< 0.35.

### D4 — Replay CLI scope → OPEN

The audit plan needs replay to *re-simulate learning* (goal seeding, exemplar /
anchor / negative updates), not just replay stored `r0`. That is bigger than
WP10's original scope. Agree the larger scope before handing to Codex.

### D5 — Developer diagnostics view → OPEN

The audit plan (Open Q3) wants the popup to show `r0` / tier / audit trigger /
title-quality during the calibration era. Build a hidden dev view now?

### D6 — Extension distribution → DECIDED (deferred, 2026-07-07)

`dist/` and `node_modules/` are gitignored (correctly — the repo ships source, not
a built bundle), so sharing today is dev-only: clone → `npm install` →
`npm run build` → Load unpacked `apps/extension/dist`. CI already builds this on
macOS + Windows. When wider sharing is needed, go **option 1**: have CI zip `dist/`
and attach it to a GitHub Release on tag, so a non-builder can download
`kibitzer-extension.zip`, unzip, and Load unpacked. Deferred — not building now.
Rejected: committing `dist/` (git churn). Chrome Web Store stays a later option for
true end-user distribution.

## Backlog (consolidated 2026-07-08, post-P1)

P0 + P1 + detection fixes + Ollama Cloud stack are all shipped. What remains,
in rough priority order:

**Trust spine (the critical path):**
1. **D4 — Replay CLI scope decision** (user + Claude) → then Codex handoff.
   Everything in `judgment-audit-plan.md` is gated on this.
2. **D3 — goal enrichment**: rides the Tier 1 cloud provider; OPEN only on
   prompt/shape (joint copy, then Codex plumbing).
3. Audit-plan chain after replay exists: title-quality gate → Tier 0 OK audit
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
7. Persona live-tone tuning after real use (celebrate/nag lines that land
   flat); D5 dev diagnostics view decision.
8. **D6 — extension release zip** via CI → GitHub Releases (decided, deferred).

**Known cosmetic/debt:**
9. `{return_minutes}` renders "0분" for sub-minute returns — fine for
   dry_kibitzer, review for other personas.
10. progress.md is a running log with some stale early entries (e.g. the
    2026-07-06 "Tier 1 = local Ollama" era) — history, not corrected, but new
    entries should note supersessions.

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
- 2026-07-08 (P1 design layer): Claude completed the design handoff — celebration
  toast (happy-arc eyes as the observer's one expression change; buttonless
  markup fix: `[hidden]` was defeated by `.row{display:flex}` and celebrations
  showed all three buttons), break copy `5분만` + button order confirmed, popup
  personas from `GET /personas`, pending card 2×2 buttons + "왜?" (tier1_reason)
  toggle, and the 리포트 view (hourly focus strip / longest stretch / feedback
  counts / top drift hosts / recent judgment reasons). Verified in browser
  preview light+dark; 90 tests green; build green. Decisions logged in
  handoff-p1-claude-design.md. P1 attachment loop is now feature-complete.

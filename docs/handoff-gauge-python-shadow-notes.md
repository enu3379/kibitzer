# Gauge track B (Python) — shadow notes

Append-only working log for the B track. Newest entry on top.

---

## 2026-07-21 — Milestone B1 complete (pure reducer + fixture runner)

### What I built

- `apps/server/app/core/controllers/gauge.py` — pure gauge reducer (contract §2–§6):
  - Dataclasses `GaugeConfig`, `GaugeState`, `GaugeEvent` (tagged union on `type`),
    `GaugeEffect`, `GaugeTransition`.
  - `reduce_gauge(state, event, config) -> GaugeTransition`. No clock/DB/network/logging;
    "now" is only `event.ts` (epoch ms). Op order per §5: **inertia → accel transition →
    integrate**, then celebration + S=0 gates. `advance` runs for `heartbeat`/`nav`/
    `tier2_result`; `inactive`/`snooze` do not integrate.
  - Purity: `reduce_gauge` copies state with `dataclasses.replace` and only *reassigns*
    nested dicts (`pending_tier2`, `last_judgment`), never mutating the caller's objects.
  - `from_json`/`to_json` on state/config/event with explicit camelCase↔snake_case key
    maps (`_STATE_KEYMAP`, `_CONFIG_KEYMAP`, `_EVENT_KEYMAP`, plus nested `_PENDING_KEYMAP`/
    `_JUDGMENT_KEYMAP`). The shared JSON keys (`activeVerdict`, `accelTier`, `rDrain`,
    `tauM`, `tUp`, …) are never renamed. Config placeholder knobs (§8) live only in
    `GaugeConfig` (defaults = §8 placeholders; fixtures pin their own `config`).
- `apps/server/tests/test_gauge_fixtures.py` — auto-discovers every repo-root
  `fixtures/gauge/*.json`, replays through `reduce_gauge`, and asserts per
  `fixtures/gauge/README.md` runner semantics: golden `final_state` (exact within
  `tolerance`), property `assert` operators (`== >= <= < > near`), and
  `effects_contain` (union of effects across all events, subset match on listed keys).

### Test results

- New fixtures: `01-one-heartbeat-drift-drain` (golden), `02-single-drift-long-dwell-
  reaches-zero` (property), `03-scattered-short-skims-barely-move` (property) — **all pass**.
  `01` reproduces the pinned `s=94.0`, `m=0.18126924692201818`, `accelTier=0` exactly, so
  the dynamics/op-order match the contract.
- Full suite (shared `.venv`, py3.14):
  `323 passed, 1 skipped, 1 warning, 56 subtests passed in 8.38s`
  (baseline 319 passed / 1 skipped + 4 new gauge tests = 323).

### Contract ambiguities hit and how I resolved them (faithful-minimal; flagged for A)

None of the three current fixtures exercise the items below, so these choices are
**unvalidated by fixtures**. Proposing A add fixtures to pin them (dual-track sync protocol).

1. **`T_down[tier]` indexing (demotion).** Contract §5 / design §4 write both promotion and
   demotion as `[tier]`. Indexing *demotion* by the current tier is unworkable: `t_down`
   has 2 entries `[0.2, 0.5]` but demoting from tier 2 would need `t_down[2]` (out of range),
   and it leaves `t_down[0]` unused with a degenerate (band-less) hysteresis. The only
   self-consistent reading — and the one that matches the explicit word "히스테리시스" and the
   2-transition array sizes — is to index demotion by the **destination** tier:
   *demote from tier T if `m ≤ t_down[T-1]`* (tier1→0 at 0.2, tier2→1 at 0.5). Promotion
   stays literal: *promote from tier T if `m ≥ t_up[T]`* (0→1 at 0.5, 1→2 at 0.8).
   (Separately, the promotion-rejection refund `m ← min(m, t_down[tier])` in §5.2a is kept
   **literal** — tier ∈ {0,1} there, so both indices exist; that is a clamp, not a transition.)

2. **`inactive` semantics.** §5 excludes `inactive` from the advance (time-forwarding) set
   and says "적분 정지". I implemented it as: **rebase the clock (`updated_at = event.ts`),
   integrate nothing, emit nothing.** This freezes state and prevents the *entire* away
   span from being integrated on the next tick; the residual up-to-`gapCap` leak on the
   return tick is the contract's intended `gapCap` behavior ("gap 초과분 무시"). A fixture
   pinning an active→inactive→return sequence would lock this down.

3. **`snooze` semantics.** Not an advance event. Implemented as: set `snoozed_until`,
   integrate nothing, **do not** rebase the clock — so the next heartbeat still integrates
   the elapsed span, honoring §6 "스누즈 중 적분은 계속". While snoozed, `nag`/`request_tier2`
   effects are suppressed; renag debt is *retained* (not zeroed) so a due nag fires on unsnooze.

4. **S=0 gate firing (dedup).** The gate fires **only on the crossing** `s_before > 0 →
   s ≤ 0` (not on every subsequent tick while S sits at 0). This keeps Tier 2 / nag call
   counts bounded (§5.2 "호출 수 유계") and still emits the fixture-02 `request_tier2{s_zero}`
   exactly once. Re-nagging while S stays 0 is handled by the `renag_debt` schedule (§6),
   not by re-firing this gate.

5. **Single outstanding `pending_tier2`.** State models one pending slot. Normal-mode
   promotion emits `request_tier2{promotion}` only when `pending_tier2 is None` (no
   duplicate promotion requests while waiting, §5). At S=0 with a promotion still pending
   (fixture 02), the s_zero gate still emits `request_tier2{s_zero}` and overwrites the
   pending slot to `s_zero` (S=0 is the terminal gate). No fixture asserts `pending_tier2`.

6. **Degraded weight with no margin.** `f(margin)` needs `active_margin` (set from a nav's
   `r0`/`tauOk` in degraded mode). If a degraded step has no margin yet, I fall back to
   `w = 1.0` rather than 0. Untested; flagged.

7. **First-nav / null active verdict.** With `active_verdict is None`, `advance` integrates
   nothing and just rebases the clock, then `nav` swaps in the new page. This is what makes
   fixture 03 land on `s=97.0` (the very first `nav@ts=0` has Δ=0 and no prior page to drain).

### Scope

- B1 only. Not wired into the server, no `gauge_states` table, no trigger — that is B2/B3.
- `streak`/`alignment` controllers and the shipped default controller are untouched.
- Stopping here for review per the handoff.

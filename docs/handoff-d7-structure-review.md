# Handoff — D7 structure review (analysis only)

**Task type: analysis / second-opinion review. Do NOT modify application code.**
The deliverable is a written report (see "Deliverable" below).

## Context

Kibitzer is a local, non-blocking attention guard: the user declares a goal,
the system observes Chrome navigation, and it comments only when drift
accumulates. Python FastAPI server + Chrome MV3 extension; the server is the
single source of truth for session state, the extension service worker is only
an event relay.

We have just finished designing **D7 — Time-budget drift rule** (see
`docs/planning-notes.md`, section "D7 — Time-budget drift rule → RESOLVED",
committed on this branch). Before implementing it we want an independent
review of the current architecture against that design.

## Files to study first

- `AGENTS.md` — repo guide and workflow rules
- `apps/server/app/api/observations.py` — ingest pipeline
  (tier0 embedding score → tier1 LLM rescue → controller → tier2 confirm+message)
- `apps/server/app/core/relevance.py`, `core/controller_flow.py`,
  `core/controllers/`, `core/tier1_payload.py`, `core/tier2_payload.py`
- `apps/server/app/storage/sqlite.py` — sessions, observations, controller
  state, exemplars/anchor, intervention/celebration records
- `apps/extension/src/background.ts` — dwell timers (5 s observation dwell,
  10 s tier2 dwell), `request_excerpt` flow, notification delivery
- `configs/default.yaml` — tier/controller/dwell/relevance knobs
- `docs/planning-notes.md` — the D7 design (clocks, thresholds, pending state,
  heartbeat, dual Tier-2 judgment, defer semantics)

## Questions to answer (all four)

1. **Current structure.** Summarize the full path from one Chrome nav event to
   a notification as you understand it, naming every timer, threshold, and
   state transition involved (observation dwell, tier0 `tau_ok`, tier1 rescue,
   streak k / cooldown / snooze / coldstart, `request_excerpt`, tier2 dwell,
   tier2 confirm, celebration path).
2. **Fit.** Where does the D7 design integrate cleanly into this structure,
   and where does the current structure resist it? Be specific — cite files
   and functions.
3. **Plan.** D7 requires: a per-page dwell clock plus a mode clock
   (continuous-since-last-OK when `controller.type=streak`, cumulative session
   drift time when `alignment`); an extension heartbeat (~30–60 s,
   `chrome.alarms`) because the server only sees nav events; excerpt capture
   and storage on **every** observation (char-limited, sensitive-domain rules
   applied); an optional time-budget field at goal declaration (total
   threshold = budget × 1/6, floored at ~5 min; fixed 15 min fallback without
   a budget; per-page threshold ~3 min; single-page valve at total/2); and a
   dual Tier-2 judgment (title-based and content-based in parallel — either
   one saying "acceptable for this time budget" defers the nag to the next
   total-threshold multiple on the mode clock). Propose the storage schema and
   control-flow changes you would make, in implementation order.
4. **Risks.** Structural risks, edge cases (sleep/wake, tab switches, service
   worker teardown, clock skew, sessions without budgets, very short budgets),
   or simpler alternatives we are missing.

## Deliverable

Write the full analysis to `docs/reviews/d7-structure-review.md` (create the
directory) and commit it to this branch. English or Korean both fine. Cite
file paths throughout. Analysis only — no application code changes.

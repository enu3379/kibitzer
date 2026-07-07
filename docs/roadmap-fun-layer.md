# Roadmap: The Fun Layer

Date: 2026-07-06
Status: planned. Stage 0 pipeline (observe → judge → intervene → feedback) is
implemented and verified end to end in real browsing; this roadmap turns the
working plumbing into a product people keep.

## Product thesis

The category (Forest, one-sec, Cold Turkey) dies of notification fatigue within
weeks. Kibitzer's differentiator is that an LLM sees the current page and writes
a contextual sentence about it. The bet: **personality-driven nagging** — messages
that feel like a character watching over your shoulder, optionally spoken aloud —
turns an ignorable notification into something users show their friends.

Target users: geeks and ADHD developers. What they respond to:

- Contextual humor over generic alerts (novelty keeps working when repetition fails).
- Shame-free redirection (shame → avoidance → uninstall, especially for ADHD).
- Local-first privacy (already true: Tier 0/1 run on-device).
- Customization and scriptability (custom personas, status-line integration).

Hard precondition, carried from Stage 0: **false-positive nagging cannot be saved
by humor.** Trust features (feedback learning, judgment transparency, cross-session
memory) outrank personality features whenever they conflict.

## Stages

### P0 — Soul (persona engine + voice)

The single highest-leverage change: replace the fixed Tier 2 message prompt with a
persona system, add escalation awareness, and let the Mac speak the nag.

- Persona presets defined in `configs/personas.yaml` (content authored by Claude;
  loading/plumbing by Codex). Three launch personas: dry kibitzer (default),
  nagging busybody, quiet coach (ADHD-friendly).
- Escalation variables injected into the Tier 2 prompt from the event log:
  nag count today, whether the previous nag was ignored, minutes since last OK,
  repeat-host flag.
- Voice delivery via macOS `say` (server-side, zero deps), default off.
- Quiet hours: suppress notification + voice but keep the pending-intervention
  badge/popup card, so nags are never lost, only silenced.
- Runtime settings (persona, voice, quiet hours) in SQLite with a settings API;
  YAML remains the defaults layer.

Detailed handoff: [handoff-p0-persona-engine.md](handoff-p0-persona-engine.md)

### P1 — Attachment (the reasons to keep it installed)

- Return celebration: detect drift→OK transitions and deliver one quiet positive
  line ("복귀까지 4분. 나쁘지 않네요.") — reinforcement over punishment.
- "5분만" (intentional break): a feedback action that starts a timer and checks
  back once, guilt-free.
- Custom personas: user-defined YAML entries with their own system prompt.
- Session report expansion: daily related-ratio, top drift hosts, longest focus
  stretch, delivered as a popup view (data already in SQLite).
- Judgment transparency: "왜?" affordance showing the stored Tier 1/2 reasons.

Detailed handoff: [handoff-p1-attachment-loop.md](handoff-p1-attachment-loop.md)
(execute after P0 merges; interfaces may shift with P0.)

### P2 — Distribution and persistence

- `kibitzer status` CLI + tmux/starship status-line snippet (streak gauge in the
  terminal — the screenshot that spreads).
- Webhooks (Slack/Discord) for self-imposed public accountability.
- Cross-session learning (Stage 1): persist confirmed exemplars across sessions.
- Replay CLI (Work Package 10) doubles as the persona/threshold A/B harness.

Detailed handoff: [handoff-p2-distribution.md](handoff-p2-distribution.md)
(interface-level only; write the full handoff when P1 lands.)

## Ownership and boundaries

To avoid file collisions between parallel workers:

| Area | Owner |
|---|---|
| Server plumbing (`apps/server/**`), config schema, loaders, APIs, tests | Codex |
| `configs/personas.yaml` content (voices, prompts, fallback lines) | Claude |
| Popup UI (`apps/extension/src/popup/**`), all user-facing copy | Claude |
| `apps/extension/src/background.ts`, `lib/api.ts` plumbing | Codex (P0), then Claude for copy-bearing parts |
| Docs: progress.md entries for own work | each worker |

Rule from the bundling round: when both sides must touch the same file
(e.g. `manifest.json`), the handoff names the exact keys each side owns.

## Design principles (apply to all stages)

- Personas are fixed per user choice, never rotated — character consistency builds
  attachment; the LLM provides sentence variety.
- Default persona is the quiet coach for new users? No — default stays the dry
  kibitzer (brand identity), but onboarding copy points ADHD users to the coach.
- Voice is opt-in (off by default). Quiet hours ship disabled by default until the
  popup exposes them, with a meeting-hours preset one tap away.
- Every new intervention pathway must degrade to the popup pending card when the
  OS suppresses notifications (lesson from the macOS delivery incident).
- Message length stays clamped (`delivery.max_sentences`); nagging is one beat,
  not a paragraph.

# Handoff P2: Distribution and Persistence

Date: 2026-07-06
Scope owner: delegated agent (Codex), **do not start until P1 merges**. This is a
placeholder plan; write the full handoff (verified file states, schemas, acceptance
checks) when P1 lands.
Parent plan: [roadmap-fun-layer.md](roadmap-fun-layer.md)

## Planned features

1. **`kibitzer status` CLI** — implement the stub in `apps/server/app/cli/main.py`:
   `status` (one-line: tracking state, streak gauge, related ratio, pending nag),
   `--format tmux|starship|json`. Reads the existing HTTP API; no new server code.
   The tmux/starship snippet is the shareable artifact — keep output under ~24 chars.
2. **Webhooks** — `delivery.webhooks: [{url, events: [intervention.created, ...]}]`
   in config; fire-and-forget POST with the event payload; per-URL failure logging,
   never blocks the pipeline. Security note: URLs are user-configured local trust.
3. **Cross-session learning (Stage 1 scope decision needed first)** — persist
   `related`-confirmed exemplars into a `goal_profiles` table keyed by normalized
   goal text; on session start with a matching goal, seed exemplars from the
   profile. This changes the purpose.md Stage 0 boundary — requires an explicit
   decision entry in progress.md before implementation.
4. **Replay CLI (Work Package 10)** — original DoD still applies
   (`kibitzer replay --session <id> --config <path>`, compare intervention points);
   extended to also replay persona/threshold variants for A/B tuning.

## Boundaries

CLI output formatting and any user-facing text: Claude. Everything else: Codex.

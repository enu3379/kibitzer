# Work order — split Tier 2 context judgment from persona writing

Date: 2026-07-16
Base: `origin/dev` at `4d62765`
Working branch: `codex/tier2-judge-writer`

## Objective

Replace the current Tier-2 contract, where every call both judges drift and
writes a persona message, with one context judgment followed by a conditional
message-writing call:

1. A single Context Judge receives title, excerpt, recent history, and time
   budget. It returns a small decision JSON without persona instructions.
2. Only `notify` invokes a Message Writer. The writer receives the selected
   persona and nagging context, but does not reconsider the decision.
3. A judge failure defers. A writer failure uses the existing local persona
   fallback and still notifies.

This work order covers product code and tests. Persona prose and few-shot
examples are intentionally delegated to Claude.

## Evidence behind the change

The 2026-07-16 live MiniMax M3 comparison used six balanced synthetic cases
and three repeated notification cases.

- Current dual calls: 4/6 correct, 12 calls, 20,588 total tokens, 128.5 s.
- Split flow: 6/6 correct, 9 calls, 16,863 total tokens, 83.1 s.
- Balanced-batch savings: 25% calls, 18.1% total tokens, 35.3% wall time.
- Tier-2 JSON at a 4,096 output cap: 0 parse failures in 27 calls.
- MiniMax ignored `think:false` for writer calls; observed writer output reached
  811 tokens, so a 512–640 writer cap is not safe for this model.

The experiment is useful directional evidence, not a production failure-rate
guarantee.

## Integration dependencies

Do not independently rewrite the overlapping prompt/persona files before
reconciling these branches:

- `origin/fix/tier2-prompt-injection-hardening` (`99b7a96`) owns the common
  instruction/data security guard and touches both provider implementations.
- `origin/feature/persona-likability-revamp` (`d9b6e53`) owns persona fragments,
  loader changes, voice prompts, and the v4 voice benchmark.

Integration order:

1. The transport, decision, orchestration, and regression tests are implemented
   on this branch from current `dev`.
2. Rebase the prompt-injection guard before this branch merges, resolving its
   common-guard changes into the Judge and Writer system layers.
3. Have Claude supply the Writer style layer through the seam below.
4. Rebase/merge the persona revamp and rerun its voice benchmark.

## Product contracts

### Context Judge result

The strict schema stays code-owned, not in persona YAML:

```json
{
  "decision": "notify|defer",
  "reason_code": "off_goal|useful_side_branch|insufficient_evidence",
  "basis": "title|content|both"
}
```

Represent this as a typed immutable result, for example `Tier2Decision`.
Reject missing or unknown enum values. Continue to recover a single JSON
object from Markdown fences as the current parser does.

### Context Judge input

The combined payload contains:

- declared goal;
- time-budget state and current review boundary;
- current title and URL host;
- current minimized excerpt, when available;
- up to 30 recent title observations;
- up to the configured recent excerpt count (currently five);
- a compact repeat-host signal.

Consecutive identical title/host observations should be represented once with
a repeat count. Do not include persona text or `nagging_context` in this call.
Content evidence must be able to override a generic or suspicious title.

### Message Writer result and input

The Writer returns plain text, not JSON. Empty or whitespace-only content is a
writer failure.

The Writer receives:

- goal;
- current title and URL host;
- the accepted Judge decision/reason/basis;
- time-budget state;
- `nagging_context` (`nag_count_today`, ignored, elapsed drift, repeat host);
- the resolved persona style layer.

Do **not** send page excerpts or recent excerpt text to the Writer. The persona
voice audit established an over-the-shoulder observer style; quoting page-body
details feels like surveillance. Page references should come from the title or
host. The writer must not reconsider or reverse the Judge decision.

Claude owns the persona wording/few-shot examples. Product code owns the plain
text requirement, maximum length/sentence clamp, and non-reconsideration guard.

## Provider API

Evolve the current `confirm_tier2()` provider method into two explicit calls:

```python
async def decide_tier2(
    payload: dict[str, object],
    system_prompt: str | None = None,
) -> Tier2Decision: ...

async def write_tier2_message(
    payload: dict[str, object],
    system_prompt: str,
) -> str: ...
```

Both OpenAI-compatible and Ollama-chat providers must support the methods.

- Judge: JSON mode, temperature 0, 4,096 output-token cap.
- Writer: plain text mode, current temperature policy, 1,024 output-token cap.
- Ollama Writer: omit `format: "json"`; send `think: false` as best effort, but
  retain the 1,024 cap because MiniMax currently ignores the flag.
- OpenAI-compatible Writer: omit `response_format: json_object`.
- Key rotation remains per HTTP call. Judge and Writer may start on different
  keys; retry only the existing 401/403/429 cases.

Configuration should expose separate phase budgets while accepting the old
experiment-model `max_output_tokens` as a Judge-budget compatibility alias:

```yaml
tier2:
  recent_observations: 30
  max_output_tokens: 4096 # backward-compatible Judge budget key
  writer_max_output_tokens: 1024
```

An experiment model entry's `max_output_tokens` remains the Judge budget; the
new `writer_max_output_tokens` overrides the Writer budget independently.
The gitignored local MiniMax entry must be migrated to Judge 4096 / Writer 1024
during rollout; never commit its API keys.

## Orchestration and failure semantics

Use the same orchestration for both the default excerpt-confirmation path and
the D7 time-budget path. Do not preserve the D7 parallel title/content calls.

1. Build one combined payload and call Judge once.
2. On `defer`, record the existing cancelled/deferred state and do not call
   Writer.
3. On `notify`, resolve the current persona and call Writer once.
4. Clamp the returned message through the existing delivery path.
5. Recheck goal revision, effective verdict/page-label override, and review or
   intervention ownership after the final awaited call before committing an
   intervention.

Failures:

- Missing/failed/invalid Judge: record provider error and defer. Do not create
  an intervention from a local fallback because the drift decision is unknown.
- Failed/empty Writer after a successful notify decision: use the existing
  persona fallback and create the intervention; provider health remains error
  because a real generation stage failed.
- Successful `defer`, or successful Judge + Writer, records Tier-2 health as
  success and clears an older red provider-call state.

Record provider-call health once for the logical review outcome, not once per
subcall. This prevents completion order from making a late failure overwrite a
successful review (the source of the stale red-dot behavior in the dual-call
flow). Keep the external `/health.provider_calls.tier2` schema unchanged.

## Compatibility boundaries

- Preserve existing `tier2.confirmed`, `tier2.cancelled`,
  `tier2.provider_error`, D7 review, intervention, and delivery event schemas.
- Preserve popup/API response schemas; no extension change should be required.
- Preserve quiet hours, voice delivery, message clamping, page-label override,
  goal-revision safety, candidate idempotency, and D7 review locking.
- Keep local fallback rotation exactly as implemented by the persona engine.
- Remove the old `confirm_drift + message` parser only after all callers and
  fake providers have migrated.

## Expected code locations

- `apps/server/app/core/tier2_payload.py` — combined payload and title-history
  compression.
- `apps/server/app/core/personas.py` — separate code-owned Judge guard from the
  Claude-owned Writer style composition seam.
- `apps/server/app/providers/judges/base.py` — typed decision and protocol.
- `apps/server/app/providers/judges/openai_compatible.py` — JSON Judge and
  plain-text Writer transports/parsers.
- `apps/server/app/providers/judges/ollama_chat.py` — JSON Judge and plain-text
  Writer transports/parsers.
- `apps/server/app/providers/judges/factory.py`, `apps/server/app/config.py`,
  `configs/default.yaml`, `configs/experiment-models.example.yaml` — phase
  budgets and compatibility migration.
- `apps/server/app/api/observations.py` — shared sequential orchestration and
  single logical health update.

If `observations.py` grows further, extract the provider orchestration into a
small `core/tier2_review.py` service; database state transitions should remain
in the API/pipeline boundary.

## Required tests

Provider and parser tests:

- accept strict and fenced Judge JSON;
- reject missing/unknown decision, reason, or basis;
- Writer request is plain text mode and accepts normal Korean text;
- empty Writer output is a failure;
- assert 4,096 Judge and 1,024 Writer request caps for both provider styles;
- assert Ollama Writer omits JSON format and requests `think: false`;
- preserve key rotation and retry behavior across sequential calls.

Payload tests:

- one combined payload contains title and current excerpt;
- recent title limit is 30, not five;
- consecutive duplicate titles are compressed with repeat counts;
- Judge payload excludes persona and nagging context;
- Writer payload excludes excerpts and includes nagging context.

Pipeline tests:

- off-goal decision calls Writer once and notifies;
- useful side branch defers and never calls Writer;
- suspicious generic title with relevant excerpt can defer on content basis;
- missing excerpt still produces exactly one title-capable Judge call;
- Judge failure defers, creates no intervention, and reports health error;
- Writer failure notifies with persona fallback and reports health error;
- the next fully successful logical review clears the old health error;
- label/goal changes while Judge or Writer is in flight cannot commit a stale
  intervention;
- D7 review boundary and old non-D7 candidate idempotency remain intact.

Run before PR:

```sh
python -m pytest apps/server/tests -q
cd apps/extension && npm run build
```

PR target is `dev`; use a Conventional Commits title and check AI-assisted.

## Out of scope

- Authoring or selecting persona prose/few-shot examples.
- Changing extension UI or provider-error wording.
- Changing Tier 1 or the controller/time-budget thresholds.
- Removing local fallbacks.

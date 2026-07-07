# Judgment Audit Plan

## Context

This document records the current concern about Kibitzer's relevance judgment
pipeline and the proposed fix direction.

The active live-test goal was:

```text
국내 여행지 탐색
```

The user raised a broader problem: clicking `관련 있어요` on a multi-purpose
platform should not make the whole platform related. For example:

- Airbnb can contain domestic trip planning and unrelated overseas trip browsing.
- Naver can contain travel search, news, shopping, webtoons, payments, and maps.
- Claude or another AI chat app can contain work on the current project or a
  different conversation.

The user also rejected a hardcoded conflict dictionary such as:

```text
국내 -> 일본, 도쿄, 오사카
```

That rejection is correct. The system should not require hand-maintained
semantic opposition lists for every possible goal.

## Current Tier Responsibilities

### Tier 0

Tier 0 is the local, cheap, CPU-only filter. It embeds browser navigation titles
and computes:

```text
r0 = max(max cosine to goal exemplars, beta * cosine to anchor)
```

If `r0 >= tau_ok`, the observation is currently marked `OK`.

Important current behavior:

- Tier 0 uses title text only.
- URL host is not embedded because host tokens previously acted like domain
  whitelisting.
- `관련 있어요` adds the observation embedding as a goal exemplar.
- The anchor is computed from recent OK observations.
- A Tier 0 OK currently skips Tier 1.

### Tier 1

Tier 1 is a cheap hot-path classifier. It receives only:

- declared goal
- current title
- current URL host
- recent title/verdict pairs

It does not receive:

- page body
- query string
- complete browsing history
- sensitive-domain content

Its role is to make a fast `ok|drift` decision over minimized metadata.

### Tier 2

Tier 2 is the rare confirmation and message generation step. It receives a
bounded page excerpt only after the controller decides an intervention may be
worth showing. Its job is to reduce false-positive notifications and generate
the final message.

Tier 2 should remain rare. It should not become the default fallback whenever
Tier 1 is unsure.

## Log Findings

The local SQLite log had 118 observations for the `국내 여행지 탐색` session.

### Airbnb

`www.airbnb.co.kr` had 45 observations:

- 42 OK
- 3 DRIFT
- most OK observations were Tier 0 terminal decisions

Two clear overseas Airbnb listings passed Tier 0:

```text
오사카 ... 일본 - 에어비앤비
r0=0.234, verdict=OK, tier=0

도쿄도, 일본 - 에어비앤비
r0=0.254, verdict=OK, tier=0
```

With the current `tau_ok=0.15`, both pass as OK without Tier 1 review.

Generic Airbnb title rows also became `r0=1.0` after `관련 있어요` was clicked:

```text
에어비앤비 | 휴가지 숙소, 통나무집, 해변가 주택 등
```

This shows that a generic platform title can become a strong exemplar and then
quietly approve future pages on the same platform.

### Naver

Naver sports was handled well:

- `m.sports.naver.com`: 10 observations, all DRIFT.
- Most sports pages reached Tier 1 and were classified as unrelated to travel.

Other Naver surfaces were weaker:

- shopping/product pages
- webtoon
- series
- pay
- generic `NAVER`

Several of these became Tier 0 OK with low but threshold-passing scores:

```text
티엔지티 Sorona Polo Shirts ... : TNGT
r0=0.191, verdict=OK, tier=0

네이버 웹툰
r0=0.151, verdict=OK, tier=0

네이버 시리즈
r0=0.203, verdict=OK, tier=0
```

These look like false OKs.

### Claude and AI Tools

Claude was handled well in the sampled log:

- `claude.ai`: 3 observations, all DRIFT.
- All three reached Tier 1.

However, this was because the titles were not similar enough to the current
travel goal. If the user clicked `관련 있어요` on a Claude conversation, later
Claude conversations could become difficult to distinguish by title alone.

Ollama and sign-in pages were mostly DRIFT, but one low-margin false OK appeared:

```text
전화번호를 입력하세요
r0=0.191, verdict=OK, tier=0
```

### Low-margin OK Bucket

Rows with `0.15 <= r0 < 0.25` are especially suspicious.

In the sampled log, this bucket included:

- Airbnb URL-like room titles
- an overseas Airbnb listing
- Naver shopping/product pages
- Naver webtoon/series pages
- generic portal/payment/sign-in pages

These are exactly the pages that should be audited before becoming OK.

### Missing Positive Distribution

The first audit looked mostly at false OKs. That is not enough to calibrate
thresholds.

The low threshold `tau_ok=0.15` is itself a symptom: a one-line goal plus one or
two weak exemplars produces a low-separation embedding space. If true related
pages and false OKs both live around `0.15` to `0.30`, then no audit band can be
both cheap and accurate.

Before choosing `audit_ok_below`, the replay dataset needs hand labels for both:

- known false OKs
- known true OKs

Then thresholds should be chosen from labeled histograms, not guessed from a
small set of failures.

## Root Problems

### Goal Representation Is Underpowered

The current goal representation starts from the user's raw goal text and a small
number of session exemplars. For short Korean goals such as `국내 여행지 탐색`,
the positive embedding distribution can remain too close to unrelated but
surface-similar titles.

This makes routing harder than it needs to be. If the positive signal is weak,
the system must either audit too many pages or accept holes.

### Tier 0 OK Is Too Final

Tier 0 is currently allowed to stop the cascade. If it says OK, Tier 1 and Tier 2
do not see the observation. That is efficient, but it creates silent false OKs.

### Multi-purpose Platforms Need Content-level Judgment

The site itself is not enough. Airbnb, Naver, Claude, ChatGPT, and similar
platforms can be either on-goal or off-goal depending on the specific page or
conversation.

### Exemplar and Anchor Contamination

`관련 있어요` and recent OK pages are useful feedback mechanisms, but they can
over-generalize:

- A generic title can become a strong exemplar.
- A false OK can enter the anchor.
- Once the anchor drifts, nearby pages are more likely to become OK.

### Title Quality Is Not Guaranteed

Some observations had titles that looked like raw URLs with query-like content.
Those strings should not be used as strong semantic input. They also create a
privacy smell even if they arrived through the browser title field.

### Negative Evidence Is Not Learned

The current feedback loop learns positive examples through `관련 있어요`, but it
does not learn session-local negative examples. Yet negative data already exists:

- Tier 1 DRIFT observations
- Tier 2 confirmed drift observations
- user-accepted interventions

Without negative exemplars, the system has no vector-space repeller for pages
that are close to the platform or topic but off-goal.

### Replay Must Re-simulate Learning

Replay cannot simply reuse stored `r0` values. New enrichment, exemplar hygiene,
anchor rules, and negative exemplars change the state trajectory itself.

Replay must re-simulate:

- goal seeding
- observation scoring
- Tier 1 audit decisions
- anchor updates
- feedback-driven exemplar updates
- negative exemplar updates

Intervention count comparisons are useful but imperfect because real browsing
would have changed after a different intervention. Detection-layer metrics are
more reliable than exact downstream browsing predictions.

## Design Decisions

### Do Not Add a Hardcoded Conflict Dictionary

Kibitzer should not encode domain-specific semantic conflicts such as:

```text
domestic travel conflicts with Japan, Tokyo, Osaka
paper reading conflicts with pricing pages
```

This would be brittle and would not scale across goals.

### Do Not Make `uncertain` a Normal Tier 1 Verdict

Tier 1 should remain a cheap binary classifier. If `uncertain` becomes common,
Tier 1 turns into a router to Tier 2, which weakens the privacy and cost model.

Keep Tier 1 output as:

```json
{"verdict":"ok|drift","reason":"..."}
```

### Audit Triggers Are Acceptable

The system can use generic, goal-independent triggers to decide when a Tier 0 OK
needs Tier 1 review.

These triggers are not semantic conflict rules. They are risk controls around
confidence and data quality.

### Fix Signal Before Calibrating Routing

Audit bands are useful, but they are not the primary fix. The first durable
improvement should make the positive goal representation stronger.

`goal enrichment` should come before final threshold calibration.

### Use Static Risk Hosts Only as Cold-start Controls

Static risk hosts are acceptable as a conservative cold-start mechanism, but
they should not be the long-term core of the system.

Session data can identify multi-purpose platforms dynamically:

```text
same host has both OK and DRIFT in the current session
  -> audit Tier 0 OKs on that host

current page is close to both positive and negative exemplars
  -> contested zone, audit Tier 0 OK
```

Risk-host config should remain a backstop, not the main intelligence.

## Proposed Solution

### 0. Label the Current Log and Build Histograms

Before changing thresholds, label the current 118 observations by hand:

- true OK
- false OK
- true DRIFT
- false DRIFT
- title quality
- host family

Then build histograms for:

- true OK `r0`
- false OK `r0`
- true DRIFT `r0`
- Tier 1 call rate
- Tier 1 call rate over time

The key health metric is whether Tier 1 calls decrease as the session learns. If
Tier 1 calls do not decline over time, Tier 0 is not absorbing the user's goal.

### 1. Add Goal Enrichment

At goal start, call a cheap LLM once to derive K positive goal phrases:

```text
raw goal: 국내 여행지 탐색

derived exemplars:
- 국내 지역별 숙소 탐색
- 국내 여행 코스와 동선 찾기
- 제주 부산 강릉 양평 같은 국내 여행 후보 비교
- 국내 여행지 맛집과 주변 명소 조사
- 국내 숙박 예약 후보 검토
```

Embed these derived phrases locally and seed them as goal exemplars with explicit
provenance:

```text
provenance = "derived"
```

The derived text is not a conflict dictionary. It is a richer positive
representation of the user's own goal. It should be replay-tested and capped.

Expected benefit:

- true positives move upward in `r0`
- `tau_ok` and `audit_ok_below` become meaningful boundaries
- fewer pages need Tier 1 audit after the session warms up

### 2. Add Title Quality and Exemplar Hygiene

Flag titles as low quality when they are:

- empty
- the same as a generic platform name
- URL-like
- dominated by path/query-looking text
- very short generic navigation labels

Low-quality titles should:

- trigger Tier 1 audit if Tier 0 says OK
- be blocked from entering anchor updates
- be blocked from becoming strong exemplars directly

`관련 있어요` should never become a placebo. If the user clicks it on a generic
title, apply the controller/feedback side effect, but split learning from
feedback:

```text
feedback is recorded
intervention state is updated
exemplar learning is conditional
```

For explicit `관련 있어요` on a generic title, the extension may collect a small
local metadata bundle:

- `document.title`
- `og:title`
- `description`
- first `h1`

Use that bundle for local embedding only. Do not send it to Tier 1/Tier 2 and do
not persist raw metadata unless it is separately sanitized.

### 3. Add Negative Exemplar Logging, Then Learning

Do not implement full negative scoring in the first behavior patch. First prepare
the data path.

Log candidate negative examples when:

- Tier 1 returns DRIFT
- Tier 2 confirms drift
- the user accepts an intervention as correct

Each candidate must pass the same title-quality gate as positive exemplars.
Generic titles must not become negative repellers either.

In the next milestone, store session-local negative exemplars with a cap:

```text
goal_negative_exemplars(session_id, position, vector_json, source, created_at)
```

Negative exemplars then support a contested-zone trigger:

```text
positive_score high and negative_score high
  -> audit Tier 0 OK
```

This is the principled successor to a conflict dictionary. The system learns
exclusions from the session instead of hardcoding semantic opposites.

### 4. Add Dynamic Mixed-host Audit

Use current-session evidence before static host lists:

```text
same eTLD+1 / host family has both OK and DRIFT
  -> audit Tier 0 OKs on that host family
```

This would have caught the sampled Airbnb and Naver behavior without needing a
large static list.

Host matching should use normalized host families rather than exact strings so
`www.`, `m.`, `search.`, and similar subdomains do not leak through trivially.

Static risk hosts can remain as cold-start defaults for known multi-purpose
platforms.

### 5. Add Tier 0 OK Audit

Tier 0 should have three practical outcomes:

```text
r0 < tau_ok
  -> DRIFT candidate, call Tier 1 if available

tau_ok <= r0 < audit_ok_below
  -> low-confidence OK, call Tier 1 audit

r0 >= audit_ok_below
  -> high-confidence OK, accept unless another audit trigger fires
```

Initial placeholder:

```yaml
relevance:
  tau_ok: 0.15
  audit_ok_below: 0.35
```

This value must be calibrated after goal enrichment and labeled replay. The
sampled log suggests many false OKs sit between `0.15` and `0.25`, but the true
OK distribution still needs to be measured.

### 6. Add Configurable Risk Hosts

Use config, not code, for multi-purpose platforms whose titles often need
metadata-level review:

```yaml
judgment_audit:
  risk_hosts:
    - "claude.ai"
    - "chatgpt.com"
    - "gemini.google.com"
    - "perplexity.ai"
    - "www.airbnb.co.kr"
    - "www.naver.com"
    - "search.naver.com"
    - "news.naver.com"
    - "m.sports.naver.com"
    - "shopping.naver.com"
    - "blog.naver.com"
    - "cafe.naver.com"
    - "comic.naver.com"
    - "series.naver.com"
```

This list is not a whitelist or blacklist. It only says:

```text
Tier 0 OK on this host may need Tier 1 review.
```

For the initial conservative version, risk hosts should audit all Tier 0 OKs.
After replay, relax this to low-confidence or mixed-host cases if Tier 1 call
volume is too high.

### 7. Strengthen Tier 1 Prompt, Keep Binary Output

Tier 1 should receive audit context such as:

```json
{
  "audit": {
    "trigger": "low_margin_ok|risk_host|low_quality_title|mixed_host|tier0_drift",
    "tier0_score": 0.234
  }
}
```

The prompt should say:

- Same website or same broad platform is not enough for OK.
- A user-confirmed exemplar is an example, not a domain-wide permission.
- Judge whether the current title/host are useful for the declared goal.
- If the current page appears to be a different task inside the same platform,
  classify as drift.
- Use only the minimized metadata; do not assume hidden page content.
- Return strict binary JSON.

Tier 1 still returns only `ok|drift`.

### 8. Keep Tier 2 Behind the Controller

If Tier 1 audits a Tier 0 OK and returns DRIFT, the observation should enter the
controller as drift. Tier 2 should still run only after the streak/cooldown logic
requests an excerpt.

This preserves the current privacy boundary:

```text
No continuous page body collection.
No excerpt unless an intervention candidate exists.
```

### 9. Protect Anchor and Exemplar Updates

Anchor and exemplar updates should use trusted OKs:

- derived goal exemplars
- high-confidence Tier 0 OK with a content-specific title
- Tier 1 audited OK
- user feedback on a content-specific page or sanitized metadata bundle

They should not use:

- generic platform titles
- URL-like titles
- low-margin Tier 0 OK that was not audited
- pages later contradicted by feedback

## Expected Effects

The current sampled log suggests these improvements:

- Overseas Airbnb listings become Tier 1-audited instead of silently OK.
- Naver shopping/webtoon/series false OKs become Tier 1-audited.
- Naver sports remains DRIFT.
- Claude remains usable when it is genuinely on-goal, but a different Claude
  conversation is more likely to be caught.
- Generic platform titles stop acting as domain-wide permission.
- Goal enrichment should raise true-positive scores so thresholds become less
  brittle.
- Negative exemplars should eventually make repeated nearby drift easier to
  catch without a hand-written conflict dictionary.
- Tier 2 remains rare and intervention-focused.

## Implementation Plan

### Step 0: Labeling and Histograms

Label the current session log and build positive/negative `r0` histograms. Do
not choose final thresholds until this exists.

### Step 1: Goal Enrichment

Add a goal-enrichment provider call when a goal is declared. Store derived
phrases with provenance and embed them locally as initial exemplars.

### Step 2: Title Quality and Exemplar Guardrails

Add a small title-quality helper:

```text
apps/server/app/core/title_quality.py
```

It should classify titles as:

- `content_specific`
- `generic`
- `url_like`
- `empty`

Use title quality in anchor and exemplar update rules.

### Step 3: Audit Config

Extend config with:

```yaml
judgment_audit:
  enabled: true
  audit_ok_below: 0.35
  audit_risk_hosts: true
  audit_low_quality_titles: true
  audit_mixed_hosts: true
  risk_hosts: [...]
```

### Step 4: Observation Routing

Change `/observations/browser-nav` so Tier 1 runs when:

- Tier 0 says DRIFT, as today.
- Tier 0 says OK but `r0 < audit_ok_below`.
- Tier 0 says OK and title quality is low.
- Tier 0 says OK and host is configured as a risk host.
- Tier 0 says OK and the current host family has both OK and DRIFT in-session.

Use audit metadata in the Tier 1 payload.

### Step 5: Prompt Update

Update both judge providers' Tier 1 system prompts with the stricter same-platform
language while keeping the strict JSON contract.

### Step 6: Negative Exemplar Logging

Record negative-exemplar candidates without changing scoring yet. This makes the
next milestone measurable without mixing too many behavior changes into one
patch.

### Step 7: Tests and Replay

Add focused tests for:

- overseas Airbnb under domestic travel
- Naver shopping/webtoon under travel
- Naver sports under travel
- Claude same-host different-title behavior
- URL-like titles
- low-margin OK auditing
- goal enrichment seeding
- generic title feedback with conditional exemplar learning
- Tier 2 still only after controller request

Then run dynamic replay over the current SQLite observations to compare:

- number of Tier 1 calls
- Tier 1 call rate over time
- false OK reduction
- true OK retention
- audit trigger mix
- Tier 2 call count

## Non-goals

- No hardcoded semantic conflict dictionary.
- No continuous page body collection.
- No broad domain whitelist from `관련 있어요`.
- No normal `uncertain` Tier 1 verdict.
- No automatic Tier 2 call for every ambiguous page.
- No static risk-host list as the long-term primary solution.

## Open Questions

1. Initial risk-host behavior: start by auditing all Tier 0 OKs on risk hosts,
   then relax only after replay proves the call volume is too high.
2. Generic-title `관련 있어요`: never reject the feedback. Record it and apply
   intervention/controller side effects. Make exemplar learning conditional on
   better title or metadata quality.
3. Developer diagnostics: yes. The popup should show `r0`, tier, audit trigger,
   and title-quality category while testing.
4. `audit_ok_below`: do not choose from `{0.25, 0.30, 0.35}` by intuition.
   Choose from labeled histograms after goal enrichment changes the score
   distribution.
5. Negative exemplars: first log candidates, then add scoring in the next
   milestone once replay can show their effect.

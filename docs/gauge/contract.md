# Gauge v0 — language-neutral behavior contract

Status: v0 (2026-07-21). Frozen semantics from `docs/analysis-plan-a-gauge-design.md`
§1–§6 (planning-notes **D9**). This file is the **single source of truth** that both
implementations must satisfy:

- **A track (TypeScript)** — `apps/extension/src/core/gauge/` (the migration target).
- **B track (Python)** — `apps/server/app/core/controllers/gauge.py` (interim, real-data
  validation; deleted when the Python server is removed).

Both implement a **pure reducer** with no I/O and validate against the shared fixtures
in `fixtures/gauge/*.json`. Divergence between the two implementations is a contract
bug: fix the fixture first (the contract), then both implementations.

Locked decisions (design §10 → D9): S recovers fully to 100 (no session cap); degraded
mode weights **both** directions by `f(margin)`; plan B (`streak`) is not a design
constraint; page-switch impulse disabled (`J_page = 0`). All §8 numeric knobs are
**placeholders** until D4 calibration — they live only in `GaugeConfig`, never inline.

---

## 1. Reducer signature

```
reduceGauge(state: GaugeState, event: GaugeEvent, config: GaugeConfig) -> GaugeTransition
```

- **Pure.** No clock, storage, network, or notification access. "Now" arrives only as
  `event.ts` (epoch milliseconds). Same `(state, event, config)` ⇒ same output, always.
- **Deterministic float math.** IEEE-754 doubles, `exp` from the platform math library.
  Fixtures compare floats within `tolerance` (default `1e-6`).
- `GaugeTransition = { state: GaugeState, effects: GaugeEffect[] }`. Effects are **intents**;
  shadow mode records them but does not act. The reducer MUST still emit them so the
  contract is stable when wiring is added later.

## 2. GaugeState

| field | type | init | meaning |
|---|---|---|---|
| `s` | float [0,100] | 100 | 몰입 게이지 |
| `m` | float [-1,1] | 0 | 관성 (+1 이탈 지속, -1 복귀 지속) |
| `accelTier` | int {0,1,2} | 0 | 이산 가속 단계 |
| `updatedAt` | int ms | — | 마지막 적분 시각 |
| `activePageKey` | string \| null | null | 현재 활성 페이지 키 (`host` + `url_path_hash`) |
| `activeVerdict` | "OK" \| "DRIFT" \| null | null | 활성 페이지의 **유효** verdict (Tier2 오버라이드 반영) |
| `degraded` | bool | false | 축퇴 모드 (Tier1/2 미가용) |
| `activeMargin` | float \| null | null | 축퇴 모드용 `\|r0 − tauOk\|` (정상 모드 null) |
| `pendingTier2` | {reason,tier,pageKey,requestedAt} \| null | null | Tier2 응답 대기 (승격/ S=0) |
| `lastJudgment` | {pageKey,flow,ts} \| null | null | Tier2 판정 캐시 (fresh_window) |
| `nagN` | int | 0 | 이번 에피소드 나깅 순번 (m≤0에서 리셋) |
| `renagDebt` | float | 0 | 마지막 나깅 이후 이탈 부채 |
| `lastNagTs` | int ms \| null | null | — |
| `celebrateArmed` | bool | false | S ≤ C_arm에서 set, 칭찬 발송 시 clear |
| `snoozedUntil` | int ms \| null | null | 사용자 스누즈 (유일한 외부 게이트) |

`gauge_states`/IndexedDB 영속 필드는 이 구조를 그대로 직렬화한다.

## 3. GaugeEvent (discriminated union on `type`)

| type | fields | source |
|---|---|---|
| `nav` | `pageKey, verdict("OK"\|"DRIFT"), r0?, tauOk?, degraded?, ts` | 서버 `PipelineResult` (신규 관측 판정) |
| `heartbeat` | `ts` | presence 하트비트 틱 (활성 중) |
| `inactive` | `ts` | 자리 비움/탭 블러 — 적분 정지 |
| `tier2_result` | `flow("drift"\|"ok"), pageKey, ts` | Tier2 Judge 응답 (승격/S=0 관문) |
| `snooze` | `until, ts` | 사용자 스누즈 |

`nav`은 활성 페이지·verdict를 교체하고 즉발 효과는 없다(§4). `r0`/`tauOk`는 축퇴 모드
마진용이며 정상 모드에선 무시. 중복 이벤트(동일 사건 재전달)는 호출부가 event id로
걸러 reducer에 넣지 않는다 — reducer는 들어온 이벤트를 항상 적분한다.

## 4. GaugeEffect (intents)

| type | fields | 언제 |
|---|---|---|
| `request_tier2` | `reason("promotion"\|"s_zero"), tier, pageKey` | 정상 모드 승격 후보(§5.2a) / S=0 도달(§5.2b, 캐시 미스) |
| `nag` | `pageKey` | Tier2 `drift` 확정 후 (또는 재나깅 부채 충족) |
| `celebrate` | — | C_arm 이하였던 에피소드가 C_celebrate 이상 첫 회복 |

축퇴 모드는 Tier2가 없으므로 `request_tier2` 없이 S=0에서 곧바로 `nag`(마진 가중이
유일 안전판). 재나깅은 상태 `renagDebt`가 임계 도달 시 `nag`를 재발행.

## 5. Dynamics (design §4, 정확 규칙)

`advance` = `heartbeat`/`nav`/`tier2_result`가 시간을 전진시킬 때 실행:

```
# 단위 규약: event.ts·updatedAt은 epoch **ms**. 노브(rDrain, tauM, gapCap…)는 **초** 단위.
# advance는 Δ를 초로 변환해 적분한다:
Δ = clamp((event.ts - state.updatedAt) / 1000, 0, config.gapCap)   # 초. inactive면 이후 Δ 정지
d = (activeVerdict == "DRIFT") ? +1 : -1
w = state.degraded ? f(activeMargin) : 1.0                    # f(x)=clamp((x/M)^p,0,1)
m' = m + (d - m) * (1 - exp(-Δ / tauM)) * w
# 가속 전이(히스테리시스): m'≥T_up[tier] → 승격 후보(정상:request_tier2 emit·대기 / 축퇴:즉시 승격)
#                          m'≤T_down[tier] → 즉시 강등.  대기 중엔 현재 tier 배율로 계속 적분.
if activeVerdict == "DRIFT": s' = max(0,   s - Rdrain   * A[accelTier] * w * Δ)
else:                        s' = min(100, s + Rrecover * ((1 - m') / kRecover) * w * Δ)
```

성질(테스트로 고정): 연속 이탈이 흩어진 이탈보다 먼저 S=0 도달 / 한 번의 OK로 m 부호가
안 바뀜 / 연속 OK에서 회복 가속 / `inactive`·gap 초과분 무시. S=0 도달 시 `request_tier2`
(정상) 또는 `nag`(축퇴) emit.

## 6. Tier 2 이중 관문·환급 (design §5–§6)

- 승격 후보 → `request_tier2{promotion}` emit, `pendingTier2` set. `tier2_result` 도착 시:
  `drift`→승격 확정; `ok`→승격 취소 + `m ← min(m,T_down[tier])` + `s ← s + Brefund` +
  활성 verdict OK 오버라이드(페이지 전환까지). 판정은 `lastJudgment` 캐시.
- S=0 → `lastJudgment.pageKey==active AND now-ts ≤ freshWindow`면 캐시 재사용, 아니면
  `request_tier2{s_zero}`. `drift`→`nag` emit(S는 0 유지, 재나깅은 `renagDebt`).
  `ok`→`s ← Rdismiss`, `m ← min(m,0)`, `accelTier ← 0`, OK 오버라이드.
- 재나깅: 나깅 시 `renagDebt←0`; 이후 이탈 적분과 동일량을 부채로 쌓아
  `renagDebt ≥ min(Rrenag·Bbackoff^(nagN-1), RrenagMax)`면 다음 `nag`. 에피소드 종료(m≤0)에
  `nagN`·`renagDebt` 리셋. 나깅은 S를 건드리지 않는다.
- 칭찬: `s ≤ Carm`에서 `celebrateArmed=true`; armed 상태에서 `s ≥ Ccelebrate` 첫 도달 시
  `celebrate` emit + clear.
- 스누즈: `now < snoozedUntil`이면 `nag`·`request_tier2` 억제, 적분은 계속.

## 7. Fixture format (`fixtures/gauge/*.json`)

```json
{
  "name": "kebab-id",
  "kind": "golden" | "property",
  "description": "...",
  "config": { /* full GaugeConfig; placeholder knobs pinned here */ },
  "initial_state": { /* partial GaugeState; unset fields take the init column of §2 */ },
  "events": [ { "type": "...", "ts": 0, ... } ],
  "tolerance": 1e-6,
  "expected": {
    "final_state": { /* golden: exact fields to assert */ },
    "assert": [ /* property: e.g. {"field":"s","op":"==","value":0} */ ],
    "effects_contain": [ { "type": "request_tier2", "reason": "s_zero" } ]
  }
}
```

- `kind:"golden"` — 짧고 손계산 가능한 스텝, `final_state` 정확값 단언 (수식을 고정).
- `kind:"property"` — 긴 시나리오, `assert`로 질적 성질 단언 (S 도달 0, S 거의 불변 등).
- 재캘리브레이션(§8 노브 변경) 시 `config`가 fixture에 박혀 있으므로 golden 값만 재생성.
- 두 트랙의 테스트 러너가 **같은 파일**을 로드한다: Python `test_gauge_fixtures.py`,
  TS `reducer.fixtures.test.ts`. 새 fixture는 자동 발견(디렉터리 글롭).

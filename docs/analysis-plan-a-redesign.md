# A안(누적 드리프트) 현안 분석 및 알고리즘 재설계

작성: 2026-07-21, 분석 에이전트. 코드 기준: `agent/windows-toast-notifications` 브랜치 (b7dc8c7).
목적: A안이 명시적 설계 없이 B안(연속/streak) 및 D7 시간 규칙 설계 과정에서 부수적으로
구현·변형된 현재 상태를 정리하고, A안 전체 알고리즘을 명시적으로 재설계한다.

관련 병행 과제(이 문서에서는 언급만 하고 상세히 다루지 않음):
- TIER 0/1 오판정 분석 → 별도 과제
- 누적 드리프트 **시간 조건**(예산 클록 임계값·감쇠) 재설계 → 별도 과제
- 칭찬(celebration) 메시지 발동 조건 재설계 → 별도 과제

---

## 1. A안 현재 구현 현황

### 1.1 용어와 계보

| 명칭 | 정의 | 출처 |
|---|---|---|
| B안 | 연속 이탈 스트릭 컨트롤러 (`StreakController`, DRIFT k회 연속) | `docs/kibitzer-implementation-guideline.md` §4.3 |
| A안 | 누적 정렬도 EWMA + 히스테리시스 (`AlignmentController`) | 같은 문서 §4.4 — **"업그레이드 경로" 스케치**로만 존재 |
| 누적/연속 모드 | D7 시간 규칙에서 `controller.type`이 트리거 클록을 함께 선택: alignment → `cumulative_drift_seconds`, streak → `continuous_drift_seconds` | `docs/planning-notes.md` D7 (2026-07-14 정정) |

계보 요약:

1. 원 지침서 §4.4는 A안을 수식 3줄(`A_t = α·A_{t-1} + (1-α)·r_t`, `A_t < θ_low` 개입,
   `A_t > θ_high` 회복)과 "불만족스러우면 Page-Hinkley/CUSUM/ADWIN으로 교체"라는
   스케치로만 정의했다. 로드맵상 A안은 Stage 3("리플레이 A/B 실험") 항목이었다.
2. 2026-07-07 세션에서 A안이 구현되어 merge됨 (`docs/handoff-2026-07-07-alignment-dwell.md`).
   첫 구현은 윈도 카운트였다가 EWMA로 교체(커밋 `5a44aa0`). **이 시점에도 θ 값
   캘리브레이션 없이 placeholder로 투입**되었고, 전제 조건이던 리플레이 하니스
   (지침서 §8 "튜닝을 라이브로 하지 않는다") 없이 진행되었다.
3. 2026-07-14 D7 설계에서 "누적/연속은 두 기존 드리프트 규칙의 시간 측정 변형"으로
   재해석되어 A안에 `cumulative_drift_seconds` 클록이 결합됨 (`docs/planning-notes.md` D7).
4. D7 구현 리뷰(`docs/handoff-d7-review-findings.md` finding 1)에서 **D7 원설계의
   "drift-rule condition holds AND …" 조건이 트리거에서 제거**됨(아래 1.4 참조).
   이것이 "B안 설계하면서 자동적으로 작업된" 지점의 핵심이다.

### 1.2 상태 모델 (현재 코드)

- 이벤트 규칙 상태: `apps/server/app/core/controllers/alignment.py:5-17` —
  `alignment_score`(A_t), `drift_latched`, `armed`, `obs_count`,
  `last_intervention_ts`, `snoozed_until`. `alpha=0.85`, `theta_low=0.15`,
  `theta_high=0.3`, `coldstart_observations=5` 기본값.
- 영속화: `controller_states` 테이블. **`armed`는 전용 컬럼 없이 B안의 `streak`
  컬럼을 재사용**해 저장된다 — `apps/server/app/core/controller_flow.py:126`
  (`streak=controller.armed`), `:231` (`_save_controller_state` 동일).
- 시간 클록 상태: `drift_clock_states` 테이블 —
  `cumulative_drift_seconds`(A안 모드 클록), `continuous_drift_seconds`(B안 모드 클록),
  `current_page_drift_seconds`, `next_review_mode_seconds`
  (`apps/server/app/storage/sqlite.py:156-159`, 스키마 `:3830-3833`).
- 설정: `apps/server/app/config.py:108-122` (`ControllerConfig`,
  `theta_low < theta_high` 검증 있음), `configs/default.yaml:88-96`.
  **출하 기본값은 `type: "streak"`(B안)** — A안은 팝업 설정으로만 활성화된다.
  런타임 오버라이드: `apps/server/app/core/runtime_settings.py:28-45,103-118`
  (레거시 `"window"` 타입은 `"alignment"`로 승격, `:44-45`).

### 1.3 입력 신호 r (EWMA에 무엇이 들어가는가)

`AlignmentController.update(verdict, r)`는 관측 이벤트당 1회 호출되며
(`apps/server/app/core/controller_flow.py:34`), r 값은 경로별로 스케일이 다르다:

| 경로 | r_final 값 | 근거 |
|---|---|---|
| Tier 0 OK / Tier 1 미가용 DRIFT | 원시 코사인 `r0` (exemplar/anchor/derived max) | `apps/server/app/core/ingest.py:86-94` |
| Tier 1 OK 구제 | 상수 `RELATED_RELEVANCE = 0.85` | `ingest.py:118`, `apps/server/app/core/relevance.py:11,89-93` |
| Tier 1 DRIFT 확정 | 상수 `0.0` (`TIER1_DRIFT_RELEVANCE`) | `relevance.py:15-20` |
| 페이지 라벨 related / drift (D8) | 상수 `0.85` / `0.0`으로 치환 후 전체 타임라인 재계산 | `controller_flow.py:170-179` (`rebuild_controller_state`), `apps/server/app/core/page_labels.py:41-47` |
| r 결측 폴백 | OK→1.0, DRIFT→0.0 | `alignment.py:21-22` |

첫 관측은 `previous = r`로 시드된다(`alignment.py:25`) — 첫 페이지가 DRIFT면
A_0가 곧바로 θ_low 아래에서 시작한다.

### 1.4 트리거 경로 — 두 갈래, 그리고 EWMA의 실질적 우회

**(a) 레거시 경로** (`time_budget.enabled=false`일 때만):
`apply_controller` → `should_intervene()` (`armed ≥ 1` + coldstart/cooldown/snooze) →
`REQUEST_EXCERPT` → `/observations/{id}/excerpt` → Tier 2 → 나깅
(`controller_flow.py:37-52`, `apps/server/app/api/observations.py:954-1130`).
여기서만 EWMA의 `armed`가 실제 트리거로 작동한다.

**(b) D7 시간 경로** (출하 기본 — `configs/default.yaml:111` `enabled: true`):

1. `ingest.py:161-166` — `apply_controller(defer_intervention=config.time_budget.enabled)`:
   `should_intervene()`이 True여도 `REQUEST_EXCERPT`를 **내지 않고 NONE 반환**
   (`controller_flow.py:38-45`). 즉 이벤트 규칙은 상태 갱신만 하고 트리거 권한을 잃는다.
2. 실제 트리거는 presence(heartbeat) 경로:
   `apps/server/app/api/observations.py:387-577` → `time_review_is_eligible` +
   `seconds_until_review_due` → Tier 2 Judge/Writer → 나깅.
3. `time_review_is_eligible`(`controller_flow.py:63-85`)은 **coldstart / snooze /
   cooldown만 검사하고 `armed`·`alignment_score`를 보지 않는다.** docstring이 이를
   명시한다: "Requiring the navigation controller's streak/armed bit here would make
   a long single-page dwell impossible to review".
4. `seconds_until_review_due`(`apps/server/app/core/time_budget.py:54-81`)는
   `active_verdict == "DRIFT"`(관측 단위 Tier 0/1 판정)와 시간 임계값
   (`per_page`, `total`, `total/2`, `next_review_mode_seconds`)만 본다.

정리: **D7 원설계는 "drift-rule condition holds AND current_page ≥ per_page AND
(mode_clock ≥ total OR current_page ≥ total/2)"였으나**(`docs/planning-notes.md` D7
Trigger 절), 구현 리뷰 finding 1(`docs/handoff-d7-review-findings.md`)이 "presence
경로에서는 컨트롤러 상태가 전진하지 않아 단일 페이지 장기 체류 시나리오가 영원히
발동 불가"라는 이유로 drift-rule 조건을 DESIGN CALL로 제거했다. 그 결과 현재
기본 구성에서 A안을 선택하면:

- **EWMA(A_t, θ_low/θ_high, armed, latch)는 나깅 트리거에 전혀 관여하지 않는다.**
- A안의 실효 정의는 "관측 단위 DRIFT 판정 페이지의 활성 체류 시간을 세션 내내
  무감쇠 누적하는 클록(`cumulative_drift_seconds`) + D7 임계값"으로 바뀌었다.
- `controller.type == "alignment"`가 실제로 바꾸는 것은 세 가지뿐:
  (i) 모드 클록 선택 (`time_budget.py:39-42`),
  (ii) OK 페이지 활성화 시 `next_review_mode_seconds`/페이지별 dwell 리셋 여부 —
  streak일 때만 리셋 (`observations.py:446` `reset_review_boundary_on_ok=
  controller_config.type == "streak"`, `sqlite.py:1701-1706`),
  (iii) `/sessions/current/state` 표시 필드 (`apps/server/app/api/sessions.py:217-221`).

### 1.5 EWMA 상태가 여전히 쓰이는 곳 (부수 소비처)

- 나깅 확정 시 `on_intervened` — `armed=0`, `last_intervention_ts` 갱신(쿨다운 기점).
  D7 커밋 경로에서 `controller_state_after_intervention` 호출
  (`observations.py:869-874`, `controller_flow.py:109-141`).
- 칭찬(celebration)용 `drift_confirmed` 판정 — `ingest.py:232-259`
  `_drift_confirmed_after_observation` + `_next_alignment_score`가 **EWMA 갱신식을
  컨트롤러 밖에 복제**해서 `state.drift_latched or score < theta_low`로 판단.
  (칭찬 발동 조건 자체는 별도 과제.)
- D8 페이지 라벨 오버라이드 시 타임라인 전체 재계산 (`page_labels.py:41-47`).
- 팝업 상태 표시 (`sessions.py:214-221` — alignment일 때 `drift_threshold=1`로
  streak 표시용 필드를 재활용하는 표시 핵 포함).

### 1.6 테스트 현황

- 산술 검증: `apps/server/tests/test_controller_handshake.py:231-250`
  (alpha=0.5 EWMA 계산·히스테리시스 산술).
- D8 재계산: `test_page_labels.py:209-282`, `test_feedback.py:121-163`.
- Tier 연동: `test_tier1.py:308-356`, `test_tier2.py:600` (증거 소비 시점).
- D7-A안 교차: `test_d7_time_budget.py:821` **단 1건** (OK가 누적 경계를 유지하는지).
- 부재: 실제 r 스트림 분포 위에서 θ가 의미 있게 발동하는지 검증하는 행동 테스트,
  리플레이 기반 캘리브레이션(D4 Replay CLI 스코프는 여전히 OPEN —
  `docs/planning-notes.md` D4).

---

## 2. 문제점

### P1. EWMA가 트리거에서 무단 이탈 — A안의 판정 규칙이 사실상 삭제됨 (구조적 핵심)

근거: 1.4 (b) 전체, 특히 `controller_flow.py:63-85`, `observations.py:499-506`,
`docs/handoff-d7-review-findings.md` finding 1.

D7 원설계의 AND 조건("드리프트 규칙 성립")이 구현 수리 과정에서 제거되면서,
A안 선택 시에도 나깅 여부는 "관측 단위 DRIFT + 시간 임계값"만으로 결정된다.
세션 전체가 압도적으로 목표 정렬 상태(A_t=0.8)여도, 흩어진 이탈 dwell이
`total`을 채우면 나깅이 트리거된다(마지막 방어선은 Tier 2 Judge뿐).
"누적 정렬도가 낮을 때만 개입한다"는 A안의 정의 자체가 코드에 없다.

### P2. 이벤트 기반 EWMA는 체류 시간에 무감각 — "누적"의 단위 불일치

근거: `alignment.py:19` (`update`는 관측당 1회), `controller_flow.py:34`.

A_t는 관측 **횟수** 기반이다. 3초씩 스친 이탈 10페이지가 40분 응시한 이탈 1페이지보다
A_t를 10배 더 끌어내린다. D7이 도입한 시간 세계관(체류 시간이 예산을 소모)과
정면 충돌하며, finding 1이 EWMA 게이트를 제거할 수밖에 없었던 근본 원인이기도
하다(단일 페이지 체류 중에는 update가 다시 불리지 않아 armed가 영원히 안 됨).

### P3. r 입력 스케일 혼합 + 티어 가용성에 따른 비정상성(non-stationarity)

근거: 1.3 표, `ingest.py:86-94,105-118`, `relevance.py:11-20`.

원시 코사인(r0)과 매핑 상수(0.85/0.0)가 한 EWMA에 섞인다. 특히:
- Tier 1이 살아 있으면 DRIFT는 0.0으로 강하게 끌어내리지만, Tier 1이 죽으면
  (2026-07-07 이후 실제로 조용히 발생했던 `provider.degraded` —
  `docs/planning-notes.md` Evidence 절) DRIFT가 r0(0.3~0.5대 가능)로 남아
  A_t가 θ_low=0.15 아래로 거의 내려가지 않는다. **레거시 경로 기준으로 Tier 1
  가용성이 A안의 발동 가능성 자체를 좌우**한다.
- 임베딩 모델이 koen-e5-tiny ONNX로 교체되고 `tau_ok`가 0.55→0.6으로
  조정되었으나(`configs/default.yaml:62-67` 주석), θ_low/θ_high는 초기 placeholder
  (0.15/0.30) 그대로다. 지침서 §4.5의 경고("코사인 임계값은 임베딩 모델 간 이식
  불가. 모델 교체 = 재캘리브레이션") 위반. 실제 koen-e5 하 r0 분포에서 θ=0.15가
  도달 가능한 값인지 — **미확인** (라벨된 리플레이 코퍼스 필요, D4 의존).

### P4. θ_low / θ_high / α의 출처 불명 — 캘리브레이션 없는 상수

근거: `docs/handoff-2026-07-07-alignment-dwell.md`(값 첫 등장, 근거 기록 없음),
지침서 §4.5(θ 값 자체는 목록에도 없음), `docs/planning-notes.md` D4(리플레이 CLI
스코프 OPEN — 검증 수단 부재). α=0.85는 시간상수 약 6.2 관측 — 이 선택의 근거도
기록에 없다. 지침서 §8("튜닝을 라이브로 하지 않는다")과 모순된 상태.

### P5. 회복(감쇠) 의미론의 이중화 — EWMA는 회복하고 클록은 회복하지 않음

근거: `alignment.py:30-42`(θ_high 회복 히스테리시스) vs
`time_budget.py:39-42` + `sqlite.py:1701-1706`(`cumulative_drift_seconds`는 세션 내
무감쇠·무리셋; OK 시 경계 리셋도 streak 전용).

같은 "A안" 이름 아래 서로 모순되는 두 회복 규칙이 공존하며, 어느 쪽이 A안의
의미인지 명시적으로 결정된 적이 없다. 장시간 세션에서 아침의 이탈 10분이
저녁 나깅의 근거가 되는 것이 의도인지 불명. (클록 감쇠 여부의 세부는
"누적 드리프트 시간 조건 재설계" 별도 과제와 정합 필요.)

### P6. 스키마 얽힘 — `armed`가 B안의 `streak` 컬럼을 재사용

근거: `controller_flow.py:126,231`. 컨트롤러 전환(streak↔alignment) 시 이전
타입의 값이 새 타입의 의미로 오독될 수 있고(`streak=3` 상태에서 alignment로
전환하면 `armed=3`으로 복원됨 — `controller_flow.py:198`), `/state` 응답도
`streak=drift_score`로 armed를 노출한다(`sessions.py:212`). 명시적 설계 부재의
전형적 흔적.

### P7. EWMA 갱신식의 정의 이원화

근거: `ingest.py:249-259` `_next_alignment_score`가 `alignment.py:24-26`과 동일한
수식을 복제. 한쪽만 수정되면 칭찬용 `drift_confirmed` 판정과 실제 컨트롤러가
어긋난다. (`_drift_confirmed_after_observation`의 판정 기준
`state.drift_latched or score < theta_low` 역시 컨트롤러 밖의 독자 해석.)

### P8. 콜드스타트가 관측 횟수 기반 — 시간 세계와 부정합

근거: `controller_flow.py:77` (`obs_count < coldstart_observations` → 부적격),
`configs/default.yaml:96` (5개). 목표 선언 직후 이탈 페이지 1개를 열고 계속
머무는 세션은 obs_count=1에서 멈춰 **어떤 시간 임계값도 영원히 발동하지 않는다.**
"단일 페이지 장기 체류" 시나리오를 살리려고 EWMA 게이트를 제거(P1)했으면서,
정작 콜드스타트 게이트가 같은 시나리오를 다시 막는다.

### P9. 레거시 경로와 D7 경로의 재나깅 의미론 상이

근거: 레거시 — latch 때문에 에피소드당 armed 1회, `A_t > θ_high` 회복 전 재나깅
불가 (`alignment.py:39-42`); D7 — `next_review_boundary`로 `total` 배수마다 재검토
(`time_budget.py:84-86`, `observations.py:875`). 같은 설정(`type=alignment`)에서
`time_budget.enabled` 플래그 하나로 재나깅 정책이 완전히 달라지며, 이 차이는
어디에도 설계로 문서화되어 있지 않다.

### P10. 검증 부재 — 행동 테스트·실사용 데이터 없음

근거: 1.6. 산술 테스트만 있고 "A안이 실제 r 분포에서 언제 발동하는가"를 검증하는
테스트·리플레이가 없다. 출하 기본이 streak(`configs/default.yaml:89`)이므로 A안의
도그푸딩 증거도 문서상 확인되지 않음 — **미확인**.

---

## 3. 재설계안

### 3.1 A안의 정체성 재정의

> **A안 = 세션 누적 관점의 개입 컨트롤러.** 두 개의 직교 질문에 각각 전용 상태를
> 두고, 나깅은 두 답이 모두 "예"일 때만 후보가 된다.
>
> - **Q1 (타이밍): 이탈에 쓴 시간이 검토할 만큼 쌓였는가** → 예산 클록
>   (`cumulative_drift_seconds` + D7 임계값. 무감쇠 — "소모된 예산"은 물리량이라
>   회복하지 않는다. 임계값·감쇠 세부는 별도 과제 산출물을 준용.)
> - **Q2 (자격): 세션이 지금 실제로 이탈 상태인가** → 시간가중 정렬도 `A(t)`
>   (감쇠·회복 있음 — "현재 상태"는 회복하는 것이 맞다.)

P5의 이중 회복 의미론은 이렇게 **버그가 아니라 역할 분리로 명시화**된다:
클록은 회복하지 않고, 정렬도는 회복한다. 서로 다른 질문이기 때문이다.

### 3.2 상태 모델

```text
AlignmentState (controller_states 확장)
  A               : float | None   # 시간가중 정렬도 ∈ [0,1]
  A_updated_at    : datetime       # 마지막 시간가중 갱신 시각
  drift_latched   : bool           # 히스테리시스 래치 (유지)
  armed           : int            # 전용 컬럼 신설 — streak 재사용 폐지 (P6)
  obs_count, last_intervention_ts, snoozed_until   # B안과 공유 게이트

DriftClockState (기존 유지 — 별도 과제 소관)
  cumulative_drift_seconds, current_page_drift_seconds,
  next_review_mode_seconds, ...
```

### 3.3 입력 신호 표준화 (P3 해소)

컨트롤러 입력을 원시 코사인에서 분리해 **이산 판정-관련도 `r_ctl`**로 표준화한다:

| 관측 상태 | r_ctl |
|---|---|
| OK (tier0 / tier1 / 라벨 related) | 1.0 |
| DRIFT — Tier 1 이상 확정 또는 라벨 drift | 0.0 |
| DRIFT — Tier 0 단독 (Tier 1 미가용·미검토) | 0.3 (불확실성 반영 중간값, 노브) |

효과: A(t)가 "최근 활성 시간 중 목표 정렬 비율"이라는 **해석 가능한 스케일**이
되고, 임베딩 모델 교체가 θ를 무효화하지 않으며(θ는 r0가 아니라 판정에 걸림),
Tier 1 가용성은 0.0 vs 0.3의 완만한 차이로 축소된다(현재는 0.0 vs 0.3~0.5
원시값으로 발동 자체가 갈림). 원시 r0는 지금처럼 features 진단·리플레이용으로만
보존한다. 기존 상수 `RELATED_RELEVANCE=0.85`는 r_ctl 세계에서 1.0으로 통합
(D8 재계산 규칙도 동일 치환 — 미해결 질문 Q5).

### 3.4 누적/감쇠 규칙 — 이벤트 EWMA → 시간가중 EWMA (P2 해소)

관측 이벤트뿐 아니라 **presence heartbeat에서도** A를 전진시킨다:

```text
advance(now):
  Δ  = clamp(now - A_updated_at, 0, max_heartbeat_gap)   # 클록과 동일 gap cap
  w  = 1 - exp(-Δ / tau_A)                               # tau_A: 시간상수 (기본 600s, 노브)
  A ← (1-w)·A + w·r_ctl(현재 활성 페이지)
  A_updated_at ← now
```

- 활성 열람 시간만 가중된다(heartbeat가 없으면 Δ가 gap cap에 잘려 사실상 정지 —
  자리 비움/타 앱 사용 중 A가 오염되지 않음). 클록 누적과 동일한 presence
  파이프라인(`record_drift_presence`)을 공유한다.
- 관측 이벤트(내비게이션) 시에도 같은 `advance`를 호출한 뒤 활성 페이지를
  교체한다 — "관측당 1스텝"이라는 인위적 시간축이 사라진다.
- 40분 응시한 이탈 1페이지가 3초 스침 10페이지보다 무겁다. **단일 페이지 장기
  체류 중에도 A가 하강하므로, finding 1이 게이트를 제거해야 했던 이유가
  소멸한다** — 이것이 이 재설계의 축이다.
- 콜드스타트 시드: 첫 판정의 r_ctl로 시드(현행 유지). 단 첫 관측이 DRIFT여도
  게이트(3.5)가 침묵을 보장.

### 3.5 판정 규칙 — D7 원설계의 AND 조건 복원 (P1 해소)

```text
eligible   = coldstart 통과 AND not snoozed AND not cooldown      # B안과 공유 게이트
armed      : A < θ_low에서 에피소드당 1회 set, A > θ_high에서 에피소드 종료   # 히스테리시스 유지
review_due = 예산 클록 조건 (per_page / total / total·½ / next_boundary — D7, 별도 과제 준용)

nag 후보   = eligible AND review_due AND (drift_latched OR armed)   # ← 복원되는 조건
확정       = Tier 2 Judge가 notify일 때만 (현행 유지)
```

- 재나깅: D7의 `next_review_boundary`(total 배수) 정책으로 **단일화**하고,
  레거시 latch-단발 정책은 폐기한다(P9 해소). latch는 재나깅 억제가 아니라
  "이탈 에피소드 정의"로만 쓰인다.
- 콜드스타트: `obs_count ≥ G` **또는 활성 관찰 시간 ≥ G_t(예: 180s)** 중 먼저
  도달하는 쪽으로 완화(P8 해소; G_t는 노브, 미해결 질문 Q3).
- 임계값 초기값: r_ctl 스케일에서 θ_low=0.35 / θ_high=0.60 / tau_A=600s를
  **placeholder로 명시**하고(의미: "최근 ~10분 가중 창의 65% 이상이 이탈"),
  확정은 D4 Replay CLI 캘리브레이션으로만 한다(P4). 지침서 §8 원칙 복원.

### 3.6 B안과의 관계 — 공유 컴포넌트 vs 분리 지점

| 컴포넌트 | 공유/분리 | 비고 |
|---|---|---|
| 게이트 (coldstart/cooldown/snooze) | 공유 | `time_review_is_eligible` 유지 |
| presence 파이프라인·클록 축적 (`record_drift_presence`) | 공유 | A안은 여기에 `advance` 훅만 추가 |
| D7 임계값 구조 (`per_page`, `total`, `total/2`, boundary) | 공유 | 값·감쇠는 별도 과제 |
| Tier 2 Judge/Writer, 전달층, 피드백/라벨(D8) | 공유 | 변경 없음 |
| `controller_states` 저장 | 공유 테이블, **컬럼 분리** | `armed` 전용 컬럼 신설 |
| 모드 클록 | 분리 | cumulative(무리셋) vs continuous(OK 리셋) — 현행 |
| 이벤트/시간 규칙 | 분리 | A: 시간가중 A(t)+히스테리시스, B: streak |
| OK 시 경계·페이지 dwell 리셋 | 분리 | 현행 (`reset_review_boundary_on_ok`) 유지 |
| 재나깅 정책 | 공유 | boundary 배수 방식으로 통일 |

`Controller` 프로토콜(`controllers/base.py`)은 `advance(now, r_ctl)` (또는
`update`에 dwell 인자 추가)로 확장하고 B안은 no-op으로 구현 — Page-Hinkley 등
교체 실험 이음새(지침서 §4.4)는 그대로 유지된다.

### 3.7 설계 대안 비교

| 대안 | 내용 | 판단 |
|---|---|---|
| 1. 최소 수정: 현 이벤트 EWMA를 `time_review_is_eligible`에 게이트로만 복원 | 코드 변경 최소 | **기각** — P2 때문에 finding 1 시나리오(단일 페이지 체류 시 update 미호출 → armed 불가)가 그대로 재발. 게이트 제거의 원인을 치유하지 않고 증상만 되돌리는 안 |
| 2. EWMA 완전 폐기: A안 = 누적 클록 단일 | 가장 단순, 현 코드와 사실상 동일 | 차선 — "세션이 회복됐는데 과거 이탈 시간만으로 나깅" 오탐 구조가 영구화되고(Judge에만 의존), /state의 정렬도 신호와 change-detection 정체성(지침서 §4.4) 상실. 오탐 최우선 원칙(§1-1)에 비추어 비권장 |
| **3. 권고: 시간가중 A(t) + 클록 이원 모델 (3.1~3.6)** | 역할 분리 명시화, AND 조건 복원 | 구현량은 중간이나 A안의 원 정의("누적 이탈에만 개입")를 시간 세계에서 복원하는 유일한 안 |
| 4. Page-Hinkley/CUSUM/ADWIN 채택 | 검증된 알고리즘 | 보류 — 지침서 §4.4의 원래 경로지만 D4 리플레이 CLI 없이는 "동일 로그 위 비교"가 불가능. 3안의 Controller 인터페이스 뒤에서 후속 실험 |

---

## 4. 구현 개선 계획 (단계별)

전제: 이 문서 승인 후 착수. 각 단계는 독립 PR(대상 `dev`) 가능 단위.

**0단계 — 정리 (행동 불변 리팩터링)**
- `controller_states`에 `armed` 전용 컬럼 추가 마이그레이션, `streak` 재사용 제거
  — `apps/server/app/core/controller_flow.py` (`:126,198,231`),
  `apps/server/app/storage/sqlite.py`, `apps/server/app/api/sessions.py:212` (P6).
- `ingest.py:232-259`의 복제 수식 제거: `AlignmentController`에
  `preview(verdict, r)` 류 메서드를 두고 호출부가 그것을 쓰게 (P7).
- 회귀 테스트: 기존 `test_controller_handshake.py` 전부 녹색 유지.

**1단계 — 입력 표준화**
- `relevance.py`에 `controller_relevance(verdict, tier_reached, label) -> float`
  신설(3.3 표), `ingest.py`·`controller_flow.rebuild_controller_state`·
  `page_labels.py`가 r_final 대신 이것을 컨트롤러에 공급.
- 원시 `r_final`은 features 저장·리플레이용으로 유지(판정 감사용 불변).
- 테스트: Tier1 미가용 DRIFT가 0.3으로, 라벨 related가 1.0으로 들어가는지.

**2단계 — 시간가중 A(t)**
- `controllers/alignment.py`를 `advance(now, r_ctl)` 기반으로 재작성(3.4),
  `A_updated_at` 영속화.
- presence 경로 연결: `observations.py`의 presence 핸들러에서 heartbeat 수락 시
  `advance` 호출. **주의: 현재 OK 페이지 heartbeat는 조기 반환된다**
  (`observations.py:421-428`) — A의 회복이 작동하려면 OK 페이지 presence도
  A 갱신까지는 통과시켜야 함 (클록 축적은 계속 DRIFT 한정).
- `rebuild_controller_state`(D8)를 시간가중 재생으로 갱신 — 타임라인에 presence
  이벤트가 없으므로 관측 간 간격을 Δ로 쓰는 근사 재생 규칙 정의 필요.
- 테스트: 40분 단일 이탈 체류에서 A가 θ_low 아래로 내려가는지 / 3초 스침
  10회로는 내려가지 않는지 / gap cap이 자리 비움을 차단하는지.

**3단계 — 게이트 복원**
- `time_review_is_eligible`에 controller-type 분기 추가: alignment이면
  `drift_latched or armed`를 AND (`controller_flow.py:63-85`);
  `observations.py:499` 호출부와 `_run_d7_review`의 재검증(`:716-726`)도 동일 조건.
  B안 쪽 조건 복원 여부는 미해결 질문 Q4 (기본: B안 현행 유지).
- 재나깅 정책 단일화: 레거시 경로(`time_budget.enabled=false`)의 A안 동작은
  기존 유지(하위 호환), D7 경로만 boundary 정책 — 문서에 명시.
- 콜드스타트 시간 기준 병행(3.5) — `ControllerConfig`에 `coldstart_active_seconds`
  노브 추가, `time_review_is_eligible`에서 OR 처리.
- 회귀 테스트: A=0.8(정렬 양호) 세션에서 흩어진 이탈 dwell이 total을 채워도
  나깅 없음 / A<θ_low + total 도달 시 나깅 / 단일 페이지 체류 발동
  (finding 1 시나리오, `k=3, coldstart=5` 기본값 그대로).

**4단계 — 캘리브레이션·기본값 (D4 이후)**
- Replay CLI(D4)로 θ_low/θ_high/tau_A/r_ctl(0.3)을 사설 코퍼스에서 튜닝.
- 튜닝 결과에 따라 출하 기본 컨트롤러를 A안으로 전환할지 결정(Q6).
- `configs/default.yaml`·`docs/architecture.md`·`controllers/README.md` 갱신.

각 단계 공통: `python -m pytest apps/server/tests -q` + 확장 `npm run build` 녹색,
PR 제목 Conventional Commits, AI-assisted 체크.

---

## 5. 미해결 질문 (사용자 결정 필요)

1. **r_ctl 이산화 값** — Tier 0 단독 DRIFT의 중간값 0.3 도입에 동의하는가?
   (대안: 0.0 단일화 = Tier 1 사망 시 과민, 또는 tier0 확신도 기반 연속값 = P3 재발 위험)
2. **placeholder 임계값** — θ_low=0.35 / θ_high=0.60 / tau_A=600s로 캘리브레이션
   전까지 운용하는 데 동의하는가? (현행 0.15/0.30은 r_ctl 스케일에서 의미 상실)
3. **콜드스타트 시간 기준** — `obs_count ≥ 5 OR 활성 관찰 ≥ 180s` 완화안 채택 여부.
   완화하지 않으면 단일 페이지 세션은 계속 판정 불가(P8 잔존).
4. **B안 게이트** — 연속(streak) 모드에도 `streak ≥ k` 조건을 D7 트리거에 복원할
   것인가? (복원 시 finding 1의 단일 페이지 시나리오가 B안에서 재발 — B안은
   시간 조건 자체가 연속 클록이라 게이트 없이도 정합적이라는 것이 현 잠정 판단.
   B안 상세는 이 문서 범위 밖.)
5. **D8 정합** — 라벨 related의 컨트롤러 치환값을 0.85에서 r_ctl=1.0으로 바꾸면
   planning-notes D8의 "0.85 매핑" 기록과 어긋난다. D8 문서 갱신으로 수용하는가?
6. **기본 컨트롤러** — 캘리브레이션 후 출하 기본을 A안으로 전환할 것인가?
   (현행 기본 streak — A안 실사용 데이터 부재의 원인이기도 함, P10)
7. **레거시 경로 존속** — `time_budget.enabled=false` 경로(P9의 한 축)를 언제까지
   유지할 것인가? D7이 안정화되면 제거가 P9를 근본 해소한다.
8. **별도 과제 정합** — 예산 클록의 감쇠/리셋 여부는 "누적 드리프트 시간 조건
   재설계" 과제 산출물과, `drift_confirmed` 재정의는 칭찬 조건 과제와 상호 검토
   필요(본 설계는 클록 무감쇠·역할 분리를 가정).

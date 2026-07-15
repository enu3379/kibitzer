# 훈수꾼 (Kibitzer) — 구현 지침서

> 사용자가 선언한 목적을 기준으로 브라우징·작업 흐름을 관찰하다가, 목적에서의 이탈이 **누적**되면 논블로킹으로 훈수를 두는 로컬 상주 AI.
>
> 이 문서는 소개문이 아니라 **구현 지침**이다. 구현 세부가 아니라 지켜야 할 원리와 계약(contract)을 정의한다. 구현 중 결정이 애매해지면 §1로 돌아온다.

## 0. 한 장 요약

| 항목 | 내용 |
|---|---|
| 관찰 대상 | Stage 0: 브라우저 내비게이션 → 이후: 타이핑 에피소드, 에이전트 프롬프트 |
| 판단 질문 | "이 행동이 선언된 목적의 **정상 궤적** 위에 있는가?" |
| 개입 조건 | 단발 이탈이 아닌 **누적 이탈**, 그리고 쿨다운·스누즈·유예 게이트 통과 시에만 |
| 개입 방식 | 논블로킹 알림 1~2문장. 절대 행동을 막지 않는다 |
| 실행 환경 | 판정은 provider 설정 (Tier 1: Haiku·Gemini Flash급 경량 API ↔ 소형 로컬, Tier 2: 프런티어 API). 임베딩·세션 상태·로그는 항상 로컬 |
| 목적 입력 | Stage 0: 명시 선언. 목적 추론은 Stage n의 확장 슬롯 |

## 1. 설계 원칙 (전 단계 공통 지침)

번호가 낮을수록 우선한다.

1. **짜증 방지 > 탐지 정확도.** 이탈을 놓치는 것(미탐)은 용서되지만 오탐 연발은 프로젝트를 죽인다. 모든 기본값은 관대한 쪽으로 잡는다.
2. **판단과 개입은 다른 층이다.** 관측당 관련성 판단(노이지해도 됨)과 개입 결정(안정적이어야 함)을 절대 한 함수에 합치지 않는다.
3. **파이프라인 중심부는 소스를 모른다.** 모든 입력은 Observation으로 정규화된다. 새 감시 대상 추가 = 어댑터 하나 추가. 중심부 코드 수정이 필요해지면 설계 실패로 간주한다.
4. **YAGNI, 단 이음새(seam)는 남긴다.** 현 단계에 필요한 것만 구현하되, 교체가 예정된 지점(개입 컨트롤러, Goal provenance, 어댑터·딜리버리 채널)은 인터페이스로 분리해둔다. "확장 가능하게"는 "미리 만들어두게"가 아니다.
5. **티어 경계 = 프라이버시·비용 경계.** 행동 스트림 **전체**를 보는 층(Tier 0/1, 임베딩)은 반드시 로컬이다 — 원문이 기기를 떠나지 않고, 한계비용 0이라 판단 빈도를 아낄 필요가 없다. 프런티어 API(Tier 2)는 개입 직전의 드문 순간에만, 최소 페이로드(§4.2 규약)만 본다. streak·cooldown 게이트가 곧 API 호출의 예산 제한기다. 민감 도메인은 이 모든 것 이전에 drop되어 있어야 한다(§10).
6. **절대 논블로킹.** 어떤 개입도 사용자의 행동을 막지 않는다 — 모달, 입력 차단, 제출 차단 금지. 훈수는 옆에서 하는 말이지 손목을 잡는 것이 아니다.
7. **원시 데이터 최소 보존.** 판단이 끝나면 원문(페이지 본문, 키 입력)은 파기하고 파생물(임베딩, 판정, 메타데이터)만 남긴다. 키스트로크 원문은 어떤 형태로도 디스크 저장 금지.
8. **모든 노브는 설정으로, 모든 이벤트는 로그로.** 튜닝은 코드 수정이 아니라 설정 변경이어야 하고, 로그는 리플레이 가능해야 한다(§8).
9. **콜드스타트 유예.** 세션 시작 직후는 침묵한다. 궤적 앵커가 형성되기 전의 판단은 신뢰하지 않는다.

## 2. 아키텍처

```text
[Source Adapters]        [Core Pipeline (소스 무관)]                       [Delivery Adapters]
 browser_nav ─┐                                                            ┌─ toast (chrome)
 keystroke*  ─┼─> normalize ─> embed ─> relevance(r) ─> tiers ─> controller ─> 훈수 생성 ─┼─ telegram*
 agent_prompt*┘         │                                   │                             └─ tts/persona*
                        └──────────── event log (append-only) <──── feedback ─────────────┘
                                            │
                                     replay harness (§8)
 (*: 후속 단계)
```

책임 분리:

| 층 | 책임 | 알아야 하는 것 | 몰라야 하는 것 |
|---|---|---|---|
| Adapter | 원시 이벤트 → Observation 변환 | 소스별 API·권한 | 판단 로직 |
| Relevance | Observation → r ∈ [0,1] | Goal, 궤적 앵커 | 개입 여부 |
| Tier cascade | 싼 판단 → 비싼 판단 에스컬레이션 | 각 티어의 비용·신뢰도 | 소스 종류 |
| Controller | 개입할지 말지 결정 (세션의 뇌) | 판정 스트림, 시간 | 페이지 내용 |
| Delivery | 훈수 전달 + 피드백 수집 | 채널별 UI | 판단 로직 |

핵심 데이터 흐름 규칙: **세션 상태의 단일 진실원(SSOT)은 로컬 서버다.** 브라우저 익스텐션은 상태 없는 이벤트 릴레이로만 동작한다 (§6.1의 MV3 제약이 이 규칙을 강제한다).

## 3. 데이터 모델

스키마는 계약이다. **payload는 소스마다 다르지만 features는 공통** — 이 비대칭이 확장성의 전부다.

```text
Observation
  id, ts, session_id
  source        : "browser_nav" | "keystroke" | "agent_prompt" | ...
  payload       : 소스별 자유 필드 (browser_nav: {url, title, meta?})
                  # 원문성 필드는 판단 완료 후 파기 대상 (원칙 7)
  features      : { emb: vec, r0: float, r_final: float, tier_reached: int }
  verdict       : "OK" | "DRIFT"

Goal
  raw_text      : 사용자가 선언한 문장
  keywords      : [string]           # 선택
  exemplars     : [vec]              # "목적을 만족한다" 임베딩 집합. 시작은 raw_text 1개.
                                     # cap 20, 초과 시 FIFO. 피드백으로만 성장 (§7)
  provenance    : "declared"         # Stage n에서 "inferred" 추가 — 지금은 슬롯만 존재

SessionState   (서버 메모리 + 주기적 스냅샷)
  goal
  anchor C      : vec                # 최근 M개 OK 관측 임베딩의 평균
  controller    : { streak, last_intervention_ts, snoozed_until, ... }
  obs_count     : 콜드스타트 게이트용

InterventionLog
  ts, trigger_obs_ids, message
  feedback      : "relevant" | "accepted" | "snooze" | null
```

## 4. 판단 알고리즘

### 4.1 관측당 관련성 r (Tier 0)

```text
r0 = max(  max( cos(emb, e) for e in goal.exemplars ),   # 목적 직접 근접
           β · cos(emb, C) )                              # 정상 궤적 근접, β < 1
```

- **C (궤적 앵커):** 최근 M개의 **OK 판정 관측** 임베딩 평균. DRIFT 관측은 절대 편입하지 않는다 — 앵커 오염 방지가 자기교정의 핵심이다. 정상 심화(예: 목적 문구에 없는 하위 주제)는 C를 통해 credit을 받고, 이탈 페이지는 goal에도 C에도 가깝지 않아 어디서도 credit을 못 받는다.
- **β 할인:** 옆걸음 체인이 한 발마다 credit을 잃게 만들어 "한 발씩 새서 결국 무관한 곳 도착" 패턴을 잡는다. β=1이면 앵커가 이탈을 따라가며 면죄부를 준다.
- **콜드스타트:** obs_count < G 동안은 C 미사용(exemplar만 대조), 개입 금지.

### 4.2 티어 캐스케이드

| Tier | 입력 | 판정기 | 지연 | 역할 |
|---|---|---|---|---|
| 0 | 제목/URL 임베딩 | 코사인 | ~ms | 명백한 OK 조기 종료 (대부분 여기서 끝) |
| 1 | 목적 + 최근 k개 궤적 + 제목/URL | 소형 로컬 LLM → JSON 판정 | ~1s | 애매 케이스 판정 |
| 2 | 위 + 현재 페이지 본문 발췌 | 프런티어 API 모델 (Sonnet / GPT-5.4 mini급 이상) | 수 초 | **개입 직전 정밀 재확인 + 훈수 문장 생성** |

```text
if r0 ≥ τ_ok:   verdict = OK
else:            verdict = tier1(goal, trajectory, title/url)   # OK | DRIFT

# tier2는 관측마다 돌지 않는다.
# controller가 개입을 결정한 "직후, 발화 직전"에만 실행:
#   본문 기반 재판정 → 번복이면 개입 취소(streak 감쇠), 확정이면 훈수 생성
```

**Tier 1 판정 계약** (프롬프트의 골자):

> 입력: 목적 문장, 최근 k개의 (제목, 판정) 목록, 현재 제목/URL.
> 판정을 셋 중 하나로 강제: (a) 목적 직접 관련 (b) 정상적 곁가지/심화 (c) 이탈. (a)(b) → OK.
> 출력: `{"verdict": "ok|drift", "reason": "<10단어>"}`

"정상적 곁가지"를 명시적 선택지로 주는 것이 오탐 방지의 핵심. 이진 분류를 시키면 모델이 곁가지를 이탈로 밀어낸다.

**Tier 2 페이로드 규약:** 목적 문장 + 최근 궤적의 (제목, 판정) 목록 + 현재 페이지 본문 **발췌**(추출 후 상한 n자). 브라우징 히스토리나 본문 전체 덤프 금지 — 외부로 나가는 원문은 이 발췌가 유일하다 (원칙 5·7).

### 4.3 개입 컨트롤러 — Stage 0: 이탈 스트릭 (B안)

```text
on verdict:
  OK    → streak = 0
  DRIFT → streak += 1

should_intervene(now):
  return streak ≥ K
     and now - last_intervention ≥ cooldown
     and now ≥ snoozed_until
     and obs_count ≥ G

on intervene: streak = 0, last_intervention = now
```

**알려진 맹점 (의도된 트레이드오프):** DRIFT-OK-DRIFT-OK 교대 패턴은 영원히 발동하지 않는다. Stage 0에서는 수용한다 — 이 맹점이 A안 업그레이드의 존재 이유이며, 컨트롤러를 인터페이스로 분리해두는(원칙 4) 이유다.

```text
Controller  (교체 가능 인터페이스 — B안/A안/PH가 모두 이것을 구현)
  update(verdict, r)
  should_intervene(now) -> bool
  on_intervened(now)
```

### 4.4 업그레이드 경로 — A안: 누적 정렬도 + 히스테리시스

```text
A_t = α·A_{t-1} + (1-α)·r_t        # EWMA. 짧은 곁길을 뭉개고 지속 이탈만 통과시킴
개입: A_t < θ_low  (그리고 §4.3의 게이트들)
회복: A_t > θ_high  (θ_low < θ_high — 히스테리시스, 경계 플래핑 방지)
```

이 문제는 형식적으로 **스트리밍 변화점 감지(change detection)** — r_t 스트림의 평균이 하락으로 전환하는 시점의 탐지다. 자작 EWMA가 불만족스러우면 검증된 알고리즘으로 교체한다: Page-Hinkley 검정(관측값과 이동평균의 누적 편차가 임계 λ를 넘으면 변화 신호; 허용오차 δ, 망각계수 α 보유), CUSUM, ADWIN. Python `river` 라이브러리의 `drift.PageHinkley`가 참조 구현이고, `frouros`에 계열 알고리즘이 모여 있다. 컨트롤러 인터페이스 뒤에 숨기면 리플레이(§8)로 B안/A안/PH를 **동일 로그 위에서** 비교할 수 있다.

### 4.5 기본 노브 (전부 설정 파일로, 전부 placeholder)

| 노브 | 시작값 | 의미 |
|---|---|---|
| τ_ok | 0.55 * | tier-0 통과 임계 |
| β | 0.85 | 궤적 앵커 할인 |
| M | 10 | 앵커 윈도 (OK 관측 수) |
| K | 3 | 개입 스트릭 |
| cooldown | 5분 | 개입 간 최소 간격 |
| snooze | 15분 | 사용자 요청 침묵 |
| G | 관측 5개 | 콜드스타트 유예 |
| exemplar cap | 20 | 목적 팽창 방지 |

\* **경고: 코사인 임계값은 임베딩 모델 간 이식 불가.** 모델마다 유사도 분포가 완전히 다르다. 남의 숫자를 믿지 말고 자기 로그 며칠치의 r0 분포를 보고 캘리브레이션한다(§8).

## 5. 기술 스택 (Stage 0)

| 컴포넌트 | 선택 | 이유 | 대안 |
|---|---|---|---|
| 이벤트 소스 | Chrome 익스텐션 (MV3, TypeScript) | webNavigation/tabs API가 정확히 이 용도 | Firefox WebExtensions |
| 로컬 서버 | Python + FastAPI + SQLite | 단일 프로세스, ML 생태계(river 등) 접근 용이 | Node |
| 모델 서빙 | Ollama (OpenAI 호환 API) | 임베딩 + 생성 단일 엔드포인트, 관리 편의 | llama.cpp 직접, LM Studio |
| 임베딩 | bge-m3 | 멀티링구얼(한/영 혼용 브라우징) 셀프호스팅의 사실상 표준 | Qwen3-Embedding-0.6B (더 가볍고 instruction-aware), EmbeddingGemma-300M (초경량) |
| Tier-1 판정 | Qwen3 4B 또는 Gemma 3 4B | 4B급이면 JSON 판정에 충분 + 빠름, CJK 강함 | Phi-4-mini |
| Tier-2 판정·훈수 | 프런티어 API (Claude Sonnet / GPT-5.4 mini급 이상) | 제목 수준을 넘는 본문·궤적 종합 이해와 훈수 문장 품질은 소형 로컬로 부족. 호출이 개입 직전으로 희소해 비용·노출 모두 미미 | 중대형 로컬 모델 (완전 오프라인 모드, 품질 트레이드오프) |
| 본문 추출 | @mozilla/readability (content script) | 본문만 깔끔히 분리 | trafilatura (서버측) |
| 알림 | chrome.notifications + 액션 버튼 | 전달과 피드백 수집을 한 번에 | Telegram bot (Stage 2+) |

모델은 소모품이다 — 모델명을 코드에 박지 말고 설정으로 뺀다. Tier-2 클라이언트는 OpenAI 호환 인터페이스 하나로 작성한다: Ollama도 같은 형식을 노출하므로 `tier2.provider: api | local` 전환이 base_url·키 교체로 끝난다 (원칙 4의 이음새). 단, **임베딩 모델 교체 = exemplars·앵커·임계값 전부 무효화**임을 명심할 것.

## 6. 소스 어댑터 규약

```text
SourceAdapter
  source_id: str
  start(emit: (RawObservation) -> None)
  stop()
```

### 6.1 browser_nav (Stage 0)

관찰 이벤트는 **주의(attention)의 이동**이지 페이지의 존재가 아니다:

- `webNavigation.onCommitted` + `onHistoryStateUpdated` (SPA 대응 필수) — 활성 탭에 한해
- `tabs.onActivated` — 탭 전환도 관측이다 (옛 탭으로 돌아가는 것도 이탈일 수 있다)
- 제목은 내비게이션 후 비동기로 설정되는 경우가 많다 → 1~2초 디바운스 후 관측 확정

**MV3 제약 (아키텍처를 결정한 제약):** 서비스워커는 30초 무활동 시 종료되고, 단일 이벤트 처리가 5분을 넘거나 fetch 응답이 30초를 넘어도 종료된다. 전역 변수는 종료와 함께 소실된다. → **SW에 상태를 두지 않는다.** SW는 이벤트를 받아 즉시 로컬 서버로 fetch하고 잊는다. keepalive 꼼수는 금지(취약하고, 원칙 8의 재현성도 해침). 세션 상태는 전부 서버에 (§2의 SSOT 규칙).

기타: `host_permissions`에 로컬 서버 주소 등록. 본문 추출은 tier-2 요청이 왔을 때만 content script가 수행해 전달한다 — 상시 본문 수집 금지 (원칙 7). 이 발췌가 기기를 떠나는 유일한 원문이다 (원칙 5).

### 6.2 keystroke (Stage 2 예정 — 원칙만 먼저 고정)

- **에피소드 단위:** 키 입력을 버퍼링하다 pause > 800ms 또는 제출성 키 입력에서 flush → Observation 1개. 키 단위 판단 금지.
- **원문 불보존:** 에피소드 텍스트는 임베딩·판정 직후 파기. 로그에는 파생물만 남는다 (원칙 7의 최상급 적용 대상 — 원문이 한 번이라도 디스크에 남으면 그 파일은 키로거 산출물이다).
- **범위는 allowlist로 시작:** 전역 후킹이 아니라 감시할 앱·입력창을 명시적으로 지정하고 의도적으로 넓힌다. 소름은 기능에서 오게 하고 범위에서 오게 하지 않는다.
- **선제적이되 논블로킹:** 브라우징 훈수는 사후반응, 타이핑 훈수는 제출 전 선제 — 파이프라인은 동일하고 딜리버리 타이밍만 다르다. 단 제출을 막지는 않는다(원칙 6). 판단 지연 예산: tier-0 <100ms, tier-1 ~1s.
- OS 후킹(접근성 권한 등)은 어댑터 내부에 격리한다. 파이프라인은 keystroke가 어떻게 잡히는지 모른다 (원칙 3).

### 6.3 agent_prompt (Stage n)

에이전트에 제출되는 프롬프트를 chokepoint(래퍼/프록시)에서 가로채 Observation으로 만든다. 판단 질문이 미묘하게 다르다: "이 스티어링이 목적 달성에 유효한 방향인가". tier-1 프롬프트의 변형으로 흡수 가능한지가 실험 대상.

## 7. 훈수 딜리버리

- **형식:** ≤2문장. 현재 행동과 선언된 목적을 **둘 다 명시적으로** 언급한다 (근거 없는 잔소리 금지). 명령형 대신 지적 + 질문형.
  - 예: "『살바도르 달리 생애』 — 15분째 위키 체인이다. '논문 그림 스타일 조사'에 아직 필요한 건가?"
- **페르소나 강도는 설정으로** (건조 ↔ 비꼼). 재미 요소는 딜리버리 층에 격리하고 판단 로직에 절대 섞지 않는다.
- **버튼 = 피드백 채널:**
  - `[관련 있음]` → 해당 관측 임베딩을 goal.exemplars에 추가(세션 한정, cap 준수) + streak/A 롤백. 훈수꾼이 "배우는" 유일한 경로.
  - `[ㅇㅇ 접음]` → 수용으로 기록.
  - `[15분 조용]` → snooze 설정.
- exemplar의 영구화(세션을 넘는 학습)는 Stage n. 세션 한정이 기본이다 — 목적은 세션마다 다르기 때문.

## 8. 로깅 & 리플레이 하니스

**튜닝을 라이브로 하지 않는다.** 라이브 튜닝은 짜증을 몸으로 맞으면서 하는 이진 탐색이다.

- 모든 Observation, 판정, 컨트롤러 상태 전이, 개입, 피드백을 append-only로 기록한다 (원칙 7의 파기 규칙 적용 후의 형태로).
- `replay --session <id> --config <alt.yaml>`: 기록된 세션을 다른 노브·다른 컨트롤러로 재생 → "이 설정이었으면 개입이 언제 발생했었나" diff를 출력.
- 세션 후 회고 라벨링: 실제 발생한 각 개입에 `fair`/`annoying`, 놓친 이탈 구간에 `missed`.
- 1차 지표는 **개입 정밀도**(fair 비율). 재현율은 2차다 (원칙 1의 수치화).
- τ_ok 캘리브레이션: 첫 며칠 로그에서 관련 세션 vs 잡탕 세션의 r0 분포를 보고 결정한다.
- 이 하니스가 있어야 B안 → A안 → Page-Hinkley 교체가 "느낌"이 아니라 **동일 로그 위의 비교**가 된다. Stage 0.5로 최우선 구축.

## 9. 로드맵

| Stage | 내용 | 완료 정의 (DoD) |
|---|---|---|
| 0 | browser_nav + 명시 목적 + tier 0/1/2 + streak 컨트롤러 + toast/피드백 버튼 | **켜둔 채 하루를 보내고도 끄고 싶지 않다** |
| 0.5 | 이벤트 로그 + 리플레이 하니스 + 임계값 캘리브레이션 | 노브 변경을 리플레이로 검증할 수 있다 |
| 1 | 피드백 → exemplar 루프 안정화, 앵커·β 튜닝 | "[관련 있음]" 후 유사 페이지 오탐이 사라진다 |
| 2 | keystroke 어댑터 (allowlist) + 선제 훈수 | **파이프라인 코드 무수정**으로 어댑터만 추가되었다 |
| 3 | 컨트롤러 A안/Page-Hinkley 교체 실험 (리플레이 A/B) | 교대 패턴 맹점 해소를 로그로 확인 |
| n | 목적 추론(provenance:"inferred"), 다중 목적, agent_prompt, 영구 학습, 메타 훈수("이 시간대마다 이렇게 샌다") | — |

각 Stage는 앞 Stage의 DoD 충족 전에 시작하지 않는다. 특히 **Stage 0의 DoD가 최상위 게이트다** — 여기서 실패하면 나머지는 전부 무의미.

## 10. 함정 목록

- **오탐 연발:** 최다 사망 원인. 의심되면 K와 cooldown을 올린다. 놓치는 건 괜찮다 (원칙 1).
- **MV3 SW 상태 유실:** SW 전역 변수에 상태를 두는 순간 간헐 버그 지옥이 시작된다. §6.1 준수.
- **SPA·제목 지연:** onCommitted만 들으면 SPA 내 이동을 놓치고, 제목을 즉시 읽으면 빈 값 또는 이전 페이지 값을 얻는다.
- **임계값 이식:** 임베딩 모델을 바꾸고 임계값을 유지하면 전부 오작동한다. 모델 교체 = 재캘리브레이션.
- **앵커 오염:** DRIFT 관측이 C에 들어가면 앵커가 이탈을 따라가며 면죄부를 준다. OK만 편입, 예외 없음.
- **목적 팽창:** exemplar 무한 추가 → 모든 것이 관련 있어진다. cap + 세션 한정으로 통제.
- **다중 컨텍스트:** Stage 0은 "한 세션 = 한 목적" 가정을 명시적으로 둔다. 목적이 바뀌면 재선언한다. 정당한 멀티태스킹을 이탈로 오인하는 것은 이 가정의 대가이며, 다중 목적 지원은 Stage n.
- **키스트로크 유출:** 원칙 7은 협상 불가. §6.2 참조.
- **Tier-2 불능:** API 장애·오프라인 시 개입을 포기하지 말고 강등한다 — tier-1 판정을 신뢰하고 템플릿 문구나 로컬 모델로 발화. 훈수꾼이 네트워크와 함께 침묵하면 안 된다.
- **민감 도메인:** 은행·의료 등 도메인 blocklist는 판단 이전 단계에서 drop한다 — 관측 자체를 만들지 않는다. Tier-2가 외부 API인 구조에서는 특히 중요하다.

## 11. Non-Goals (Stage 0)

목적 추론 없음 · 다중 목적 없음 · 행동 차단 없음 · Tier 2 외 클라우드 없음 · 대시보드/통계 UI 없음 · 크로스 브라우저 없음 · 영구 학습 없음.

전부 "지금 안 함"이지 "설계에서 배제"가 아니다 — 이음새는 §3(provenance, exemplars), §4.3(Controller 인터페이스), §6(어댑터 규약)에 이미 있다.

## 12. 참고

- Chrome MV3 서비스워커 수명주기: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- river — PageHinkley 등 스트리밍 드리프트 감지: https://riverml.xyz/dev/api/drift/PageHinkley/
- frouros — 변화 감지 알고리즘 모음 (CUSUM, ADWIN 등): https://github.com/IFCA-Advanced-Computing/frouros
- Mozilla Readability: https://github.com/mozilla/readability
- Ollama 모델 라이브러리: https://ollama.com/library

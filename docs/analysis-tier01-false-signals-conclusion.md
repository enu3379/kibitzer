# TIER 1 프롬프트 통일·엄격화 — 실측 결론 (analysis-tier01-false-signals 후속)

작성일: 2026-07-21. [analysis-tier01-false-signals.md](analysis-tier01-false-signals.md)의
후속으로, 이 문서는 그중 **이번 작업 스코프에서 실행·검증한 부분만** 기록한다:
FO-9(프로바이더 간 프롬프트 비대칭) 해소, B1-c(프롬프트 단일화), 그리고
"false-drift는 Tier 2가 재심하지만 false-OK는 잡는 것이 없다"는 방향 결정에 따른
Tier 1 프롬프트 엄격화. 감사 밴드(A1), title quality 게이트(A2), 컨트롤러
신호 보존(B3) 등은 이 스코프 밖이며 원 문서의 제안이 그대로 유효하다.

## 1. 변경 내용

`apps/server/app/providers/judges/base.py`에 `TIER1_SYSTEM_PROMPT` 단일 상수를
신설하고 두 프로바이더(`openai_compatible.py`, `ollama_chat.py`)가 공유한다.

- 구 openai_compatible 전용이던 "Treat direct relevance and normal subtopics as
  ok" 문장 삭제 — 이 문장 하나가 실측에서 false-OK를 유의하게 늘렸다.
- 엄격화: "drift는 하류에서 재심되지만 ok는 종결" 명시, 목표의 구체적 과업을
  수행하는 게 명확할 때만 ok, 인접 쇼핑·잡담·뉴스·비교글 drift, 동음이의어는
  목표의 의도된 의미 기준, 신호 없는 포털/앱 제목 drift, 불확실하면 drift.
- 압축 유지: 2배 길이의 동일-규칙 초안(변형 D)은 reasoning 모델(nemotron)의
  thinking 시간을 늘려 10초 타임아웃률을 8%→16%로 두 배로 만들었다. 최종
  문구(변형 E)는 규칙을 유지한 채 절반 길이로 압축해 오류율을 8%로 되돌렸다.

## 2. 검증 방법

세 단계로 검증했다. 상세 데이터는
[benchmarks/tier1-prompt-validation/](benchmarks/tier1-prompt-validation/README.md).

1. **티어 귀속 분석** (v2 벤치마크 200쌍, tau=0.6 재현): false-OK는 구조적으로
   100% Tier 0 종결분에서 확정되고(재심 경로 부재, 원 문서 FO-1), false-drift의
   최종 수치는 전적으로 Tier 1 구제 성능에 달려 있음을 확인.
2. **프롬프트 후보 탐색** (Haiku 프록시 서브에이전트): 구 프롬프트 2종 +
   개선 2종을 비교해 방향 확정.
3. **실 프로바이더 검증** (Ollama Cloud nemotron-3-super, 프로덕션 조건):
   - v2 (165건, in-sample), v1 (168건, held-out — 프롬프트 설계에 미사용),
   - v3 (178쌍, 신규 생성 — 에이전트 3개가 미사용 목표 60개로 생성, 별도
     에이전트가 라벨 전수 재판정, 판정불가 2건 제외).

## 3. 결과

| 세트 | Tier1발 false-OK (구→신) | McNemar p | 구제 손실 (구→신) | p |
|---|---|---|---|---|
| v2 | 18/110 → 10/110 | 0.008 | 7/55 → 9/55 | 0.69 |
| v1 (held-out) | 13/107 → 5/107 | 0.021 | 0/61 → 5/61 | 0.063 |
| v3 (신규 생성) | 17/108 → 10/108 | 0.039 | 7/70 → 16/70 | 0.035 |
| 풀링 | discordant 25 vs 2 | 5.7e-6 | discordant 5 vs 21 | 0.0025 |

- **false-OK 감소(-40~60%)는 세 세트 모두 독립적으로 유의** — in-sample
  과적합이 아니다.
- **구제 손실은 실재하나 과반이 판정이 아닌 오류**(타임아웃·thinking의 출력
  예산 소진 → 빈 응답: v2 12/18, v3 10/16). 판정 수준 손실은 clickbait 제목
  (제목이 주제를 숨기는 관련 페이지)에 집중 — "확실할 때만 ok"의 본질적
  트레이드이며, 제품 방향(false-OK 우선 억제, false-drift는 Tier 2 수용)에
  부합한다.
- **잔존 false-OK는 세 세트 공통으로 한 단어 동음이의어 목표**(환급·물때·등기·
  이월류)에 집중. 목표 텍스트에 의미 구분 정보가 없어 프롬프트로는 한계이고,
  파생 문구가 페이로드에 실리는 실환경에서 추가 해소 여지가 있다(벤치마크는
  파생 문구 부재 조건).

원 문서 미해결 질문에 대한 실측 답:

- **Q2 (Tier 1은 순생산자인가 순구제자인가)**: 구 프롬프트 기준 명백한 false-OK
  순생산자다(구제를 다 해내는 대가로 true-drift의 12~28%를 뒤집음). 신
  프롬프트는 이 비율을 5~9%로 낮췄다. A1(감사 밴드)에 Tier 1을 더 태우는
  안은 이 개선을 전제로 재평가해야 한다.
- **Q3 ("normal subtopics as ok" 문장)**: 의도 여부와 무관하게 해로움이 실측
  확인되어 삭제했다.

## 4. 부수 발견

- **이 머신의 Kibitzer는 줄곧 Tier 1/2 무음 열화 상태로 동작해 왔다**
  (`/health`: `tier1: degraded, last_result: none` — 호출 기록 자체가 전무).
  키가 없어도 판정 파이프라인이 조용히 Tier 0 단독으로 도는 원 문서 FD-2의
  실증 사례이며, A3(열화 시 판정 보수화)의 근거를 강화한다.
- Tier 1 오류의 상당수가 타임아웃이 아니라 **빈 응답**(thinking이
  `max_output_tokens` 320을 소진)이었다.

## 5. 후속 과제 (이번 스코프 밖, 우선순위 제안)

1. `models.local.yaml`의 tier1 `max_output_tokens` 320→512 — 빈 응답 회수,
   설정만으로 가능.
2. Tier 1 타임아웃 1회 재시도 (원 문서 A3) — 본 검증은 재시도 1회 포함
   수치이며, 재시도 없는 프로덕션의 손실은 더 크다.
3. reasoning 비활성화(think=false) 실험 — 타임아웃 구조 자체를 제거할 수
   있는지.
4. 실세션 replay 게이트 (원 문서 5절) — 정적 벤치마크의 한계(파생 문구·recent
   리스트 부재, 실사용 분포 아님)는 도그푸딩 로그 축적 후에만 해소된다.

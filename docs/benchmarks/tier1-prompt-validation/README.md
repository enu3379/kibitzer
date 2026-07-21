# Tier 1 프롬프트 검증 (2026-07-21)

`TIER1_SYSTEM_PROMPT` 교체(구 openai_compatible 프롬프트 → 통일·엄격·압축 버전)의
실 프로바이더 검증 데이터. 모델: Ollama Cloud `nemotron-3-super`, 프로덕션 조건
(10s 타임아웃, max_output_tokens 320, 재시도 1회 — 프로덕션은 재시도 없음에 유의).

## 데이터셋

- **v2** (`docs/benchmarks/tier0-embedding-v2`): tau=0.6 기준 Tier 0 DRIFT 165건.
  신 프롬프트 설계에 실패 사례를 참조한 세트 (in-sample).
- **v1** (`docs/benchmarks/tier0-embedding`): 동일 방식 168건. 프롬프트 설계에
  미사용 (held-out). 목표·쌍 모두 v2와 0 겹침.
- **v3** (`v3_pairs.json`, 178쌍): 이 검증을 위해 신규 생성한 독립 세트.
  Sonnet 에이전트 3개가 미사용 목표 60개(생활/개발/여행·행정 도메인 분담)로 생성,
  별도 에이전트가 라벨 독립 재판정(180건 중 2건 판정불가 제외, 뒤집힌 라벨 0건).
  Tier 0 점수가 없어 Tier 1 단독 판별력 측정 (전량 재심 가정).

## 결과 (재시도 1회 포함)

| 세트 | 지표 | 구 프롬프트 | 신 프롬프트 | McNemar p |
|---|---|---|---|---|
| v2 | Tier1발 false-OK | 18/110 | 10/110 | 0.008 |
| v2 | 구제 손실 | 7/55 | 9/55 | 0.69 |
| v1 | Tier1발 false-OK | 13/107 | 5/107 | 0.021 |
| v1 | 구제 손실 | 0/61 | 5/61 | 0.063 |
| v3 | false-OK | 17/108 | 10/108 | 0.039 |
| v3 | false-drift | 7/70 | 16/70 | 0.035 |
| 풀링 | false-OK 방향 | 25 vs 2 (discordant) | | 5.7e-6 |
| 풀링 | 구제 방향 | 5 vs 21 (discordant) | | 0.0025 |

## 결론

- false-OK 감소는 세 세트 모두 유의하게 재현 (Tier1발 false-OK 약 -40~60%).
- 구제 손실도 풀링에서 유의하나, 손실의 과반이 판정이 아니라 **오류(타임아웃/
  thinking이 토큰 예산 소진 → 빈 응답)**다 (v2: 12/18, v3: 10/16). 판정 수준
  손실은 clickbait 제목(제목이 주제를 숨기는 관련 페이지)에 집중 — 엄격화의
  본질적 트레이드.
- 신 프롬프트 잔존 false-OK는 한 단어 동음이의어 목표(환급/물때/등기/이월류)에
  집중. goal enrichment 파생 문구가 페이로드에 실리는 실환경에서는 추가 해소
  여지 있음 (본 벤치마크는 파생 문구 부재 조건).
- 후속 운영 개선 후보: tier1 `max_output_tokens` 320→512 (빈 응답 회수),
  타임아웃 1회 재시도 (analysis-tier01-false-signals.md A3), reasoning 비활성화
  실험.

`real_result_{OLD,CMP}[_v1|_v3].json`: 관측 id → verdict (null = 프로바이더 오류).

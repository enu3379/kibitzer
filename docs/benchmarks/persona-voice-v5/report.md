# Persona Voice v5 — Judge/Writer 분리 후 Writer 실호출 감사

Date: 2026-07-16. Target: Ollama Chat 호환 `minimax-m3`, Tier 2 Message Writer 경로.
Calls: 10 personas × 5 scenarios × 2 예산(1024/2048) + 수정 후 재검증 10 = 110.

원자료: [results.json](results.json) (Writer 1024, 배포 기본값),
[results-writer2048.json](results-writer2048.json) (진단용 로컬 오버라이드),
[results-recheck.json](results-recheck.json) (dry/chungcheong 프롬프트 수정 후, 2048).
재현 스크립트: [`scripts/eval_persona_voice.py`](../../../scripts/eval_persona_voice.py).

## 방법

- Judge는 이번 감사 대상이 아니다. 모든 시나리오를 notify 확정으로 두고
  (`Tier2Decision(notify, off_goal, title)`) 실제 `build_tier2_message_payload` 형태
  그대로 Writer만 호출했다. 요청 파라미터는 `write_tier2_message()`와 동일하다
  (`think:false`, plain text, `num_predict=writer_max_output_tokens`).
- 시나리오는 v4와 같은 5종: 명백한 이탈(첫 알림), 반복 방문+직전 무시,
  그럴싸한 딴짓(반복), 장시간 25분+무시, 일반 이탈(첫 알림).
- `nag_count_today`에는 서버 의미 그대로 "이번 알림 이전까지 오늘 전달된 횟수"를
  넣었다. 현재 순번(+1) 환산은 코드-소유 Writer 프롬프트가 정의한다.
- 원출력, Writer 실패(빈 응답)→fallback 여부, 클램프 전후 전달문, thinking 길이,
  `eval_count`를 모두 기록했다.

## 전달 파이프라인 결과

| 항목 | Writer 1024 (배포값) | Writer 2048 (진단) |
|---|---:|---:|
| Writer 전달 | 22/50 | 44/50 |
| fallback 대체 | 28/50 | 6/50 |
| 예산 소진(`eval_count`=한도) | 31/50 | 6/50 |
| 문장 클램프 | 1/50 | 2/50 |
| 평균 지연 | 13.5s | 15.6s |

핵심 발견: **minimax-m3는 `think:false`를 무시하고 페르소나 레이어가 붙은 Writer
프롬프트에서 1~6천 자를 사고한다.** thinking이 약 3천 자를 넘으면 1024 예산이
전부 소모되어 본문이 비고, 서버는 fallback으로 강등된다. 더 나쁜 케이스로,
thinking이 한도 직전에 끝나면 **본문이 문장 중간에서 절단된 채 전달**된다
(1024 실측 2건: quiet_coach S3 "…벤치 휴식이에요. 예", navigation S2 "…복귀 안내를").
Ollama Cloud는 이때도 `done_reason: "stop"`을 반환하므로 절단은 done_reason으로
감지할 수 없고, `eval_count`가 한도에 붙었는지로만 알 수 있다.

"deliberate 하지 마라"류 프롬프트 지시는 통제 실험(3회 반복 × 3 페르소나)에서
효과가 재현되지 않았다 — kyoto는 두 변형 모두 3/3 빈 응답. temperature 0에서도
backend 비결정성이 커서 단발 관찰은 신뢰할 수 없다.

## 구조 계약 검증 (양쪽 예산 공통)

- **순번 통일**: "이번 알림 = nag_count_today + 1"을 Writer 공통 프롬프트에 정의한
  뒤 순번 발화 오류 0건 (v4에서는 모델별로 계산이 갈렸음). dry "오늘 두 번째"(prior
  1), game "오늘만 세 번째 쿠팡 픽"(prior 2), navigation "재진입 3번째"(prior 2) 모두 정확.
- **본문 세부 발명 0건**: Writer가 발췌를 받지 않는 구조에서, 제목에 없는
  가격·조회수·타이머를 지어낸 메시지가 한 건도 없다. v3의 "182만 조회, 6500원
  원가" 유의 감시 느낌이 구조적으로 제거됐다.
- **신호 장부 나열 0건**: 횟수·분·무시·재방문을 겹쳐 낭독한 메시지 없음.
  navigation도 메시지당 수치 1개 규칙을 5/5 준수.
- **판정 재검토/메타 설명 0건**: Writer가 Judge 판정을 언급하거나 번복한 출력 없음.

## 클램프 감사

| 페르소나/상황 | 제거된 내용 | 판정 |
|---|---|---|
| game_caster/S4 (1024) | 셋째 문장 꼬리 | 경보+해설 2문장은 보존, 영향 작음 |
| tsundere/S3 (2048) | 동기 부정 꼬리(4문장째) | 캐릭터 일부 유실, 빈도 낮음 |
| game_caster/S3 (2048) | 셋째 문장 복귀 제안 | 프롬프트가 금지한 배치라 모델 위반 케이스 |

## 페르소나별 판정 (2048 진단 실행 기준)

| 페르소나 | 전달 | 판정 | 관찰 |
|---|---:|---|---|
| dry | 5/5 | 수정 후 통과 | S4에서 "없사옵니다" 사극 어미 재발 → 금지를 "~옵니다류 일체"로 확장, 재검증 3/5 전달·재발 0 |
| chungcheong | 5/5 | 수정 후 통과 | S1 "거웅" 실존하지 않는 낱말 → "없는 낱말 금지" 추가, 재검증 5/5 전달·재발 0. "접시" 은유 재사용 경향은 관찰만 |
| kyoto | 3/5 | 통과(전달분) | 접힌 한 문장 예시 교체가 적중 — 전달분 모두 한 문장 이케즈. 단 thinking 최다(2/5 기아) |
| quiet_coach | 3/5 | 통과(전달분) | 다음 행동 제시 유지, 인용 어투 0건. "선수." 호격은 관찰만 |
| tsundere | 5/5 | 통과 | 변명 순환·동기 부정 안정. S2 "하나만 골라"는 명령형에 근접(관찰) |
| yandere | 5/5 | 통과 | 기계 보고체 0건, 온도차 유지, 가드레일 위반 0건 |
| navigation | 5/5 | 통과 | 수치 1개/무감정 규칙 5/5, 문형 반복성 유지 |
| documentary | 5/5 | 통과 | 장면·어휘군 단일화 적중(물웅덩이↔사냥터 혼용 0건), 전부 1~2문장 |
| game_caster | 5/5 | 통과 | 첫 알림 "비상!" 오발 0건(신규 가드 적중), 경보 수위 매핑 정확 |
| baseball_caster | 3/5 | 통과(전달분) | 주체 역전 0건, 파울/견제 프레임 정확. 2/5 기아 |

fallback으로 강등된 케이스도 전부 순번 정확한 캐릭터 템플릿이 나가므로 사용자
체감 실패는 아니다. 다만 13~35초짜리 호출이 결과 없이 버려진다.

## 우선순위 권고

1. **reasoning 모델 프로필의 Writer 예산**: 코드 기본값 1024는 유지하되,
   `models.local.yaml`의 minimax-m3 항목에는 `writer_max_output_tokens: 2048`
   오버라이드를 권고한다(이 실험에서 fallback 28/50 → 6/50). 640~1024가 부족한
   것은 모델 성향이지 프롬프트 길이 문제가 아니다 — 지시 몇 줄을 줄여도 thinking
   1~6천 자 편차는 그대로다.
2. **절단 전달 방지** (transport 소관 제안): `eval_count`가 예산에 도달했고 본문이
   비어 있지 않으면 문장 중간 절단일 수 있다. 이 경우도 Writer 실패로 취급해
   fallback을 태우는 편이 "…벤치 휴식이에요. 예" 같은 출력보다 낫다.
3. **빈 응답 1회 재시도** (orchestration 소관 제안): backend 비결정성 때문에 같은
   입력도 절반쯤은 예산 안에 들어온다. 재시도 1회로 fallback 비율을 크게 줄일 수
   있으나 지연 2배가 대가다.
4. **`think` 레벨 실험** (transport 소관 제안): boolean `false`는 무시되므로,
   Ollama가 지원하는 모델이라면 `"low"` 레벨 전달을 실험할 가치가 있다.

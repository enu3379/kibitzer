# Persona Voice v4 — minimax-m3 실호출 감사

Date: 2026-07-15. Target: Ollama Chat 호환 `minimax-m3`.
Calls: 10 personas × 5 synthetic scenarios = 50.

원자료: [results.json](results.json). 재현 스크립트:
[`scripts/eval_persona_voice.py`](../../../scripts/eval_persona_voice.py).

## 방법

- 실제 Tier 2 provider factory, 공통 guard prompt, persona style layer를 사용했다.
- 시나리오는 v3와 같은 논문/유튜브, 이력서/쿠팡, 리팩토링/패치노트,
  발표자료/넷플릭스, 자격증/더쿠 다섯 가지다.
- 실제 서버 시점에 맞춰 `nag_count_today`에는 현재 알림 전까지 전달된 횟수를
  넣었다. fallback 선택 시에만 현재 순번인 `prior + 1`을 사용했다.
- 원응답, strict JSON 여부, 코드펜스 복구, fallback, 클램프 전후 최종 전달문을
  모두 기록했다.

## 전달 파이프라인 결과

| 항목 | 결과 |
|---|---:|
| drift 확인 | 50/50 |
| strict JSON | 45/50 |
| 코드펜스 JSON 복구 | 5/50 |
| fallback 대체 | 0/50 |
| 문장 수 클램프 | 5/50 |
| 토큰 한도 종료 | 0/50 |
| 최대 `eval_count` | 1884/2560 |

2560 출력 예산에서 v3의 토큰 고갈·fallback 4건은 재현되지 않았다. 코드펜스
5건도 서버 복구 경로가 전부 흡수했다. 단, 본검증 전 dry/S1 예비 호출 1건은 JSON
객체가 아니라 JSON 문자열만 반환해 fallback으로 내려갔고, 버려진 원문에도
`이옵니다`가 있었다. `temperature=0`이어도 backend 비결정성이 있으므로 fallback은
계속 필수다.

## 클램프 감사

| 페르소나/상황 | 제거된 내용 | 판정 |
|---|---|---|
| tsundere/S1 | 동기 부정 꼬리 | 캐릭터 핵심 일부 유실 |
| game_caster/S4 | 다음 세트 만회 제안 | 핵심 행동 유실 |
| baseball/S2 | `14분째` 숫자 꼬리 | 앞 문장에 3루가 있어 영향 작음 |
| baseball/S4 | 슬라이드 복귀 제안 | 행동 유실 |
| baseball/S5 | 쿠키 페이지가 오답이라는 재설명 | 중복 제거로 오히려 짧아짐 |

서버 클램프는 안전망으로 작동했지만 5건 중 3건에서는 의도한 꼬리를 제거했다.
`어?`나 `비상!` 같은 독립 감탄문도 한 문장으로 센다는 사실을 few-shot 예시에서
더 직접 가르칠 필요가 있다.

## 페르소나별 판정

| 페르소나 | 판정 | 관찰 |
|---|---|---|
| dry | 경미 보정 | 사극 어미는 본검증 0건. S1의 추상명사 높임, S2의 `노션 충고` 결합이 번역투 |
| chungcheong | 통과 | 5건 모두 한 문장, 짧고 인칭 오용 없음 |
| kyoto | 재조정 | 목소리는 선명하지만 평균 73.8자, 최대 90자. S3은 `8%`까지 재인용하고 만연체 |
| quiet_coach | 통과 | 5건 모두 2문장 안에 구체적인 다음 행동 포함, 클램프 0 |
| tsundere | 경미 보정 | 톤은 안정. S1에서 독립 `어?` 때문에 동기 부정 꼬리 클램프 |
| yandere | 통과 | 물건을 만지거나 글이 소리 낸다는 추측 0건. 탭·사이트·시간 범위 준수 |
| navigation | 통과 | 5건 모두 숫자 1개, 2문장, 감정 어휘 없음 |
| documentary | 재조정 | S1·S5가 평균보다 길고 물웅덩이/사냥감, 군락/서식지/채집을 한 메시지에 혼용 |
| game_caster | 경미 보정 | S4 꼬리 클램프. 첫 알림 S5에 `비상!` 사용. S2는 세 번째 상황을 두 번째로 발화 |
| baseball_caster | 경미 보정 | 사용자=주자 역할은 유지. 3/5 클램프, S2는 세 번째 상황을 두 번째로 발화 |

v4에서 가장 안정적인 축은 `chungcheong`, `quiet_coach`, `yandere`,
`navigation`이다. `kyoto`와 `documentary`는 캐릭터 인식에는 성공했지만 전역 기준인
촌철살인에는 아직 못 미친다.

## 새로 확인된 구조 문제

실제 서버는 현재 알림을 만들기 전에 `nag_count_today`를 주입하므로 값은 “오늘 이미
전달된 알림 수”다. 그러나 persona prompt는 이를 “이번이 몇 번째인가”로 읽는다.
S2의 현재 순번은 세 번째지만 game/baseball은 입력값 `2`를 그대로 말했고,
dry/navigation은 문맥상 `+1`해 세 번째라고 말했다. 모델마다 계산이 갈리므로
`current_nag_ordinal`을 별도 필드로 주거나 기존 필드를 현재 순번으로 재정의해야 한다.

## 우선순위

1. `nag_count_today`의 prior/current 의미를 코드와 prompt에서 하나로 통일.
2. kyoto few-shot을 기본 한 문장으로 줄여 길이 템플릿 자체를 교체.
3. documentary가 한 메시지에서 생태 어휘군 하나만 쓰도록 예시를 더 짧게 교체.
4. tsundere/game/baseball에서 독립 감탄문을 포함한 실제 문장 예산을 예시에 명시.
5. dry에 추상명사 높임과 잘못 붙은 수식어 금지 예시 추가.

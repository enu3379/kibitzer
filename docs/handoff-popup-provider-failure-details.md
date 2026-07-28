# Popup provider failure details

## 배경

기존 팝업은 실패한 Tier를 모두 하나의 빨간 경고로 합쳐
`LLM 호출 오류 — 마지막 판정 요청이 실패했어요.`라고 표시했다. 이 문구만으로는
Tier 1과 Tier 2, Judge와 Writer, 네트워크 실패와 응답 해석 실패를 구분할 수
없었다. 두 Tier가 서로 다른 원인으로 실패하면 원인마저 일반 문구로 축약되어,
사용자는 실제로 중단된 기능과 적용된 fallback을 알기 어려웠다.

PR #108에서 `/health.provider_calls.tierN`에 추가된 `phase`와 `stage`를 사용해,
팝업은 마지막 호출이 실패한 Tier마다 별도 진단 카드를 표시한다. 서버 계약이나
재시도 정책은 바꾸지 않는다.

## 카드와 severity

카드는 항상 Tier 1, Tier 2 순서로 생성한다. `last_result`가 `success` 또는
`none`인 Tier, health가 없는 상태, offline snapshot에는 카드를 만들지 않는다.

| Tier | phase | 제목 | severity | 기능 결과 |
|---|---|---|---|---|
| Tier 1 | `judge` | `Tier 1 · 1차 페이지 판정` | amber | Tier 0 판정을 유지하므로 전체 기능은 계속됨 |
| Tier 2 | `judge` | `Tier 2 · 최종 페이지 판정` | red | 최종 판정을 완료하지 못해 개입을 보류함 |
| Tier 1/2 | `writer` | `Tier N · 훈수 문구 생성` | amber | 판정은 유지하고 로컬 기본 문구를 사용함 |
| Tier 1/2 | 없음 또는 알 수 없음 | `Tier N · LLM 호출 오류` | red | 구버전 또는 알 수 없는 계약이므로 보수적으로 표시함 |

Tier 1 Writer는 현재 정상 서버 흐름에서 발생하지 않지만, 런타임 값이 들어와도
동일한 Writer 진단으로 안전하게 처리한다. 색상은 기존 `--amber-bg`,
`--amber-tx`, `--red-bg`, `--red-tx` 변수를 재사용한다.

## reason 문구

`reason`이 `invalid_response`가 아니면 `stage`보다 기존 reason 문구를 우선한다.

| reason | 요약 |
|---|---|
| `timeout` | `Provider 응답 시간이 초과됐어요.` |
| `connection` | `Provider 서버에 연결하지 못했어요.` |
| `auth` | `API 키가 유효하지 않아요.` |
| `forbidden` | `Provider가 요청을 거부했어요. 모델 접근 권한 또는 요금제를 확인하세요.` |
| `rate_limited` | `Provider 요청 한도에 도달했어요.` |
| `server_error` | `Provider 서버에서 오류가 발생했어요.` |
| 기타 | `Provider 상태를 확인하세요.` |

## invalid_response stage 문구

| stage | 요약 | 안내 |
|---|---|---|
| `http_json` | `Provider가 올바른 JSON 응답을 보내지 않았어요.` | `API 주소와 Provider 호환성을 확인하세요.` |
| `envelope` | `Provider 응답 구조가 예상한 형식과 달라요.` | `OpenAI-compatible 또는 Ollama API 설정을 확인하세요.` |
| `content_json` | `판정 내용을 JSON으로 읽지 못했어요.` | `설정한 모델이 JSON 출력을 안정적으로 지원하는지 확인하세요.` |
| `schema` | `판정 결과의 필수 값이 올바르지 않아요.` | `모델의 판정 형식 호환성을 확인하세요.` |
| `writer_empty` | `Provider가 빈 훈수 문구를 반환했어요.` | `이번 알림은 기본 문구로 대신했어요.` |
| `output_exhausted` | `응답이 출력 한도에 걸려 완성되지 않았어요.` | 아래 phase/Tier별 안내 사용 |

`output_exhausted` 안내는 실패한 설정 경로를 구분한다.

| 호출 위치 | 안내 |
|---|---|
| Tier 1 Judge | `Tier 1 모델 속도와 max_output_tokens를 확인하세요.` |
| Tier 2 Judge | `Tier 2 max_output_tokens 또는 모델 설정을 확인하세요.` |
| Writer | `writer_max_output_tokens 또는 모델 설정을 확인하세요.` |

## 구버전과 알 수 없는 값

`reason === "invalid_response"`이지만 `stage`가 없으면 구버전 서버와 호환되도록
`Provider 응답을 판정 결과로 읽지 못했어요.`를 유지한다. phase가 없으면 제목은
`Tier N · LLM 호출 오류`, severity는 red다.

알 수 없는 phase 또는 stage가 런타임 데이터로 들어오면 throw하지 않는다. 제목은
일반 LLM 호출 오류, 요약은 `Provider 상태를 확인하세요.`로 fallback한다. 동적
Provider 원문이나 예외 메시지를 대신 노출하지 않는다.

## 동시 실패 예시

Tier 1 Judge가 timeout이고 Tier 2 Writer가 `writer_empty`라면 다음 두 카드가
동시에, 아래 순서로 표시된다.

1. amber `Tier 1 · 1차 페이지 판정`
   - `Provider 응답 시간이 초과됐어요.`
2. amber `Tier 2 · 훈수 문구 생성`
   - `Provider가 빈 훈수 문구를 반환했어요.`
   - `이번 알림은 기본 문구로 대신했어요.`

첫 카드는 Tier 0 fallback을, 둘째 카드는 로컬 기본 문구 fallback을 각각
설명한다. 서로 다른 실패를 한 문구로 합치지 않는다.

## 개인정보 보호 원칙

팝업 문구는 클라이언트에 정의된 고정 매핑만 사용한다. 다음 값은 표시하지 않는다.

- Provider 원문 응답
- 프롬프트 또는 판정 입력
- 방문 URL
- API 키
- 내부 예외 메시지

## 수용 기준

- 실패한 Tier마다 독립 카드가 Tier 1 → Tier 2 순서로 표시된다.
- Tier/phase 조합에 맞는 제목과 amber/red severity가 적용된다.
- 모든 reason 및 `invalid_response` stage가 이 문서의 고정 문구로 매핑된다.
- Tier/phase별 `output_exhausted` 안내가 올바른 설정을 가리킨다.
- 구버전 및 알 수 없는 런타임 값은 예외 없이 안전한 일반 문구로 fallback한다.
- success/none, health 부재, offline snapshot에서는 새 실패 카드를 만들지 않는다.
- 판정 축소 모드 경고와 기존 팝업 상호작용을 유지한다.
- Provider 원문, 프롬프트, URL, API 키, 내부 예외 메시지를 노출하지 않는다.
- 확장 단위 테스트, TypeScript typecheck/build, 서버 전체 테스트가 통과한다.

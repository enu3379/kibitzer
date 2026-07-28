# TIER 0/1 오판정(false-ok / false-drift) 현황 분석과 개선안

작성일: 2026-07-21. 근거는 모두 `dev` 기준 코드/문서 정독에 기반한 정적 분석이다.
로컬 판정 로그 표본 분석은 시도했으나 `data/kibitzer.sqlite3`의
`observations`/`event_log` 등 전 테이블이 0건(빈 DB)이어서 불가 — 실측 수치는
`docs/planning-notes.md`, `docs/judgment-audit-plan.md`,
`docs/handoff-goal-enrichment.md`에 기록된 과거 세션 감사 결과를 인용한다.

용어: **false-ok** = 실제 드리프트를 OK로 오판, **false-drift** = 실제 목표
부합을 DRIFT로 오판. 판정 주체는 TIER 0(로컬 임베딩 코사인)과 TIER 1(경량
클라우드 LLM 분류기)이며, TIER 2(맥락 판사/메시지 작성)는 범위 밖이다.

관련 별도 과제(이 문서에서는 언급만): A안(alignment) 알고리즘 재설계, 누적
드리프트 시간 조건(D7) 재설계, 칭찬 메시지 발동 조건 재설계.

---

## 1. TIER 0/1 현재 판정 로직 요약

### TIER 0 — 로컬 임베딩 코사인 필터

입력은 **탭 제목뿐**이다. URL 호스트는 과거 도메인 화이트리스팅 부작용 때문에
임베딩에서 제외되었다 (`apps/server/app/core/normalization.py:33-37`).
제목은 같은 호스트에서 2회 이상 반복된 사이트명 접미사("- 나무위키" 등)를
제거한 뒤 임베딩된다 (`normalization.py:46-66`, 호스트별 최근 제목 조회는
`apps/server/app/storage/sqlite.py:3413-3429`).

임베딩 모델은 KoEn-E5-Tiny qint8 ONNX, CPU 전용
(`configs/default.yaml:10-22`). 점수는:

```
r0 = max( exemplar_score,                    # 목표 seed + 관련있어요 클릭 exemplar와의 max cosine
          beta * cos(anchor),                # beta=0.85, anchor = 최근 10개 anchor-eligible OK 임베딩 평균
          derived_score if >= derived_tau )  # goal enrichment 파생 문구, derived_tau=0.25
```

(`apps/server/app/core/relevance.py:58-75`,
`apps/server/app/core/ingest.py:74-91`, anchor 계산은 `sqlite.py:3431-3445`,
anchor 소스 필터는 `sqlite.py:3373-3411`).

판정: `r0 >= tau_ok(0.6) → OK, 아니면 DRIFT` (`ingest.py:92-94`,
`configs/default.yaml:62-66` — 주석에 "cross-validation 없이 선택된 잠정값"
명시). `tau_ok` 0.6은 PR #29(ONNX 전환)에서 0.15로부터 상향된 값이다.

anchor 오염 방지 가드: exemplar_score < `anchor_epsilon(0.05)`이고 파생 문구
매치도 없고 Tier 1 검증도 안 거친 OK는 verdict는 유지하되 anchor에 투표하지
못한다 (`relevance.py:31-44`, `ingest.py:131-138`, `configs/default.yaml:70-74`).

exemplar 소스: (a) 목표 선언 시 목표 텍스트 임베딩(seed), (b) `관련 있어요`
클릭/페이지 라벨(cap 20, `apps/server/app/api/feedback.py:84-96` →
`apps/server/app/core/page_labels.py` → `sqlite.py:3065-`), (c) goal
enrichment 파생 문구 ≤8개 — 목표 선언 시 1회 클라우드 LLM 호출로 생성, 로컬
임베딩 (`apps/server/app/core/goal_enrichment.py:14-40, 99-131`).

### TIER 1 — 경량 LLM 이진 분류기 (DRIFT 재심 전용)

**Tier 0이 DRIFT일 때만** 호출된다 (`ingest.py:96`). Tier 0 OK는 종결
판정이며 어떤 감사도 받지 않는다 (docs/judgment-audit-plan.md "Tier 0 OK Is
Too Final"에서 문제로 명시, 미해결).

페이로드는 최소화 원칙: 목표 원문, 현재 제목/호스트, 파생 문구, 최근 5개
(제목, verdict) 쌍만 전송 (`apps/server/app/core/tier1_payload.py:8-33`,
`configs/default.yaml:38-44`). 페이지 본문·쿼리스트링은 전송하지 않는다.

프롬프트: "declared goal과 정렬됐는지 분류, derived_phrases 매칭 제목은
goal-related, strict JSON `{"verdict":"ok|drift","reason":...}`"
(`apps/server/app/providers/judges/openai_compatible.py:40-47`,
`apps/server/app/providers/judges/ollama_chat.py:45-52`). 두 프로바이더의
프롬프트가 **동일하지 않다** — openai_compatible에만 "Treat direct relevance
and normal subtopics as ok" 문장이 있다 (아래 FO-9).

결과 처리 (`ingest.py:115-127`):
- OK → verdict 뒤집고 `r_final = RELATED_RELEVANCE = 0.85`
- DRIFT → verdict 유지, `r_final = TIER1_DRIFT_RELEVANCE = 0.0`
  (`relevance.py:11-20, 89-93`)
- 예외(타임아웃 10s 포함) → Tier 0 verdict 유지, 오류만 기록
  (`ingest.py:106-114`)

### 하류 소비자 (판정의 파급)

verdict와 `r_final`은 컨트롤러로 들어간다: streak 모드는 DRIFT 연속 k=3에서
개입 arm, OK 1회로 streak=0 리셋
(`apps/server/app/core/controllers/streak.py:17-35`); alignment 모드는 EWMA
`A_t`가 `theta_low(0.15)` 아래로 내려가면 latch
(`apps/server/app/core/controllers/alignment.py:19-42`). D7 시간예산 모드에선
개입이 유예되고 드리프트 verdict가 모드 클록을 태운다 (`ingest.py:161-166`;
클록 재설계는 별도 과제). 사용자 페이지 라벨(D8)은 effective verdict를 즉시
덮어쓰지만 원본 verdict는 불변으로 남는다 (`sqlite.py:19-25`,
`page_labels.py`).

민감 도메인은 판정 이전에 통째로 드랍된다
(`ingest.py:49-58`, `apps/server/app/privacy/domain_filter.py:32-52`,
`configs/sensitive_domains.json`).

---

## 2. false-ok 시나리오 목록과 근거

### FO-1. Tier 0 OK의 종결성 — 저신뢰 OK가 감사 없이 통과 (구조적, 최상위)

`ingest.py:96`은 DRIFT만 Tier 1로 보낸다. `judgment-audit-plan.md`가 설계한
`audit_ok_below` 감사 밴드(Step 3–5), risk_hosts, mixed-host 감사, title
quality 게이트는 **전부 미구현**이다 — `audit_ok_below|risk_host|
title_quality|negative_exemplar`를 서버 코드 전체에서 grep하면 replay CLI의
수기 라벨 CSV 컬럼(`apps/server/app/replay/core.py:97-98, 459-462`) 외에는
없다. 실측 근거: "국내 여행지 탐색" 세션 118건에서 해외 에어비앤비
(r0=0.234/0.254), 네이버 웹툰/시리즈/쇼핑(r0 0.15–0.25)이 전부 Tier 0 종결
OK (judgment-audit-plan.md "Log Findings"; 당시 tau 0.15 하시대의 수치지만
구조는 동일).

### FO-2. 파생 문구의 aspect 확장이 준-목표 드리프트를 끌어올림

goal enrichment는 recall을 23.8%→86.2%로 올리는 대신 FPR을 11.7%→17.5%로
올렸고, 신규 false-OK는 전부 aspect 확장에서 나왔다 — 예: 목표 "영어 공부",
문구 "토익 토플 시험 준비"가 드리프트 제목 "토익 시험 접수"를 0.82로 끌어올림
(`docs/handoff-goal-enrichment.md` 2026-07-13 addendum). 이 0.60–0.82 대역은
어떤 그럴듯한 감사 밴드보다도 높아서 FO-1의 감사 밴드로도 못 잡는다고
문서에 명시돼 있다. 코드상 파생 매치는 `max()` 안에서 exemplar와 동급으로
verdict를 결정한다 (`relevance.py:66-75`; `derived_tau=0.25`는 τ=0.6 아래라
"verdict-inert", `configs/default.yaml:80-85` 주석).

### FO-3. anchor 편승과 오염 루프

`beta(0.85) * cos(anchor) >= 0.6`이면 exemplar 매치 없이 OK가 된다
(`relevance.py:67, 71`). 2026-07-08 "LG그램 수리" 세션에서 "킬로그램 -
나무위키" 1건이 anchor에 들어간 뒤 Giggle/미니언즈/호날두가 연쇄 OK된 실사례
(planning-notes.md "Evidence"). anchor 어드미션 가드가 이후 추가됐지만 잔여
경로가 있다:
- **Tier 1 false-OK는 anchor-eligible이다** (`relevance.py:43` — `verdict ==
  OK and tier_reached >= 1`). LLM이 한 번 잘못 OK하면 그 임베딩이 anchor
  평균에 들어가고, 이후 유사 페이지들이 anchor 경로로 Tier 0 종결 OK가 되는
  오염 루프가 열린다.
- 가드 플래그 도입 이전 레거시 행은 무조건 통과한다 (`sqlite.py:3404-3407`).
- anchor 경로로만 OK된 페이지도 **verdict 자체는 OK로 유지**되므로(설계 의도,
  `ingest.py:129-131` 주석) false-ok 자체는 남는다 — anchor 확산만 막았다.

### FO-4. 일반(generic) 제목의 `관련 있어요` exemplar화

`관련 있어요`는 해당 관측의 임베딩을 그대로 exemplar로 추가한다
(`feedback.py:67-70, 84-96`; 임베딩 존재만 검사). 제목 품질 게이트가 없어
"에어비앤비 | 휴가지 숙소…" 같은 플랫폼 대표 제목이 exemplar가 되면 이후 그
플랫폼의 동종 제목이 r0≈1.0으로 통과한다 (judgment-audit-plan.md "Airbnb" —
실측 r0=1.0 사례). audit plan Step 2의 `title_quality.py`는 미구현.

### FO-5. 다목적 플랫폼 / 제목-콘텐츠 불일치

Tier 0/1 모두 페이지 본문을 보지 않는다 (`tier1_payload.py:14-18` — title,
url_host뿐). 목표 관련 플랫폼(Airbnb, Naver, Claude 등) 안의 무관 페이지,
제목이 목표 어휘를 우연히 포함하는 무관 페이지(예: "킬로그램" vs "LG그램")는
원리적으로 Tier 0/1에서 구분 불가. Tier 1도 같은 정보만 받으므로 재심 가치가
제한적이다. 콘텐츠 판정은 Tier 2 전용이며 개입 후보가 있을 때만 발생
(privacy 경계, judgment-audit-plan.md "Keep Tier 2 Behind the Controller").

### FO-6. Tier 1 false-OK 한 번이 누적 증거를 지움 (증폭기)

Tier 1 OK는 `r_final=0.85`로 기록되고 (`ingest.py:118`), streak 컨트롤러에서
OK 1회는 streak를 0으로 리셋한다 (`streak.py:19-21`). 즉 드리프트 2연속 후
LLM이 3번째를 잘못 OK하면 누적이 전부 소멸한다. alignment 모드에서도 0.85는
EWMA를 강하게 끌어올린다. 오판 1건의 비용이 판정 1건이 아니라 "누적 증거
전체"라는 점에서 구조적 증폭이 있다. (컨트롤러 자체 재설계는 별도 과제 —
여기서는 Tier 1 출력에 신뢰도 구분이 없다는 점만 지적.)

### FO-7. 제목 접미사 스트리핑의 빈틈

`strip_repeated_title_suffix`는 (a) 같은 호스트의 **이전** 제목 2건 이상이
같은 접미사로 끝나야 발동 — 호스트 첫 1–2건은 사이트명 furniture가 그대로
임베딩된다 (`normalization.py:43, 65-66`); (b) 구분자 6종(" - ", " | ",
" · ", " :: ", " – ", " — ")만 인식 — 괄호형("[사이트명]"), 콜론 등은 통과
(`normalization.py:42`). furniture가 목표 어휘와 우연히 겹치면(LG그램 사례의
"그램"류) false-ok 방향으로 작용한다.

### FO-8. 같은 URL 안의 콘텐츠 드리프트 — 재판정 없음

관측은 `webNavigation` onCommitted/onHistoryStateUpdated/onCompleted에서만
스케줄되고 5초 dwell 후 그 시점의 `tab.title`로 1회 판정된다
(`apps/extension/src/background.ts:1007-1018, 508-529`). history API를 쓰지
않는 무한 스크롤 피드·탭 내 콘텐츠 교체는 진입 시 1회 OK를 받으면 이후 체류
전체가 무판정이다. D7 시간 리뷰는 드리프트 페이지 대상이므로 OK 페이지의
장시간 체류는 재심 경로가 없다 (시간 조건 재설계는 별도 과제).

### FO-9. Tier 1 프로바이더 간 프롬프트 비대칭

`openai_compatible.py:43`에는 "Treat direct relevance and normal subtopics
as ok"가 있고 `ollama_chat.py:45-52`에는 없다. "normal subtopics"의 관대한
해석은 다목적 플랫폼에서 false-ok 방향 바이어스가 된다. 어느 쪽이 의도인지
미확인 — 프로바이더 선택에 따라 판정 성향이 달라지는 것 자체가 문제.

### FO-10. 판정 시점의 제목이 로딩 플레이스홀더/이전 페이지 제목인 경우

dwell 5초 시점의 `tab.title`을 쓰므로 (`background.ts:517-518`) 느린 SPA에서
아직 갱신 전의 목표 관련 제목이 임베딩되면 무관 페이지가 OK될 수 있다.
발생 빈도 미확인 (로그 부재).

---

## 3. false-drift 시나리오 목록과 근거

### FD-1. 교차 언어 갭 (한국어 목표 ↔ 영어 제목) — 실측 최대 요인

Step-0 라벨링(실관측 231건): Tier 0 지배적 실패는 false-DRIFT로, **관련
페이지 142건 중 80건이 τ 미달**, 주로 한국어 목표 vs 영어 제목 (r0=0.000
사례: "마인크래프트 크리에이트모드" vs "How To Make a Train In Minecraft…")
(`handoff-goal-enrichment.md:13-20`). ONNX 전환 후에도 tiny 모델의 ko↔en
정렬은 약해서 교차 언어 관련 쌍이 0.26–0.59로 τ=0.6 아래에 깔린다 (addendum
:184-191; ONNX 단독 recall 23.8%, 파생 문구 결합 시 86.2%). 즉 **파생 문구가
유일한 완화책**인데—

### FD-2. goal enrichment 실패는 무음(silent)이고, 실패 시 FD-1이 그대로 노출

enrichment는 fire-and-forget이며 실패 시 이벤트 기록 후 조용히 스킵한다
(`goal_enrichment.py:144-173`). `configs/models.local.yaml` 부재 시 Tier 1
프로바이더도 함께 죽는 이중 열화가 실제로 발생했고(2026-07-08, 6분 세션에서
cold-start false-DRIFT ×6, 전부 tier_reached=0 — planning-notes.md
"Evidence"), 열화는 `/health`와 팝업 경고로 노출되게 고쳐졌으나 판정
파이프라인은 여전히 "약화된 채 정상 동작"한다.

### FD-3. 하위 주제 어휘 미도달

"수리" 목표에서 서비스센터/출장 예약 페이지가 r0 0.06–0.13 (planning-notes
LG그램 세션). 파생 문구가 하위 주제를 커버 못 하면(문구 ≤8개 cap,
`configs/default.yaml:78`) 여전히 발생. 문구 품질은 클라우드 LLM 1회 호출에
전적으로 의존하고, addendum의 성능 수치는 수기 문구 프록시 기준이다.

### FD-4. Tier 1 타임아웃/오류 → Tier 0 DRIFT 그대로 확정

`ingest.py:106-114`: Tier 1 예외 시 Tier 0 verdict 유지. 실측 타임아웃률
~17% (nemotron thinking이 10s 초과 — planning-notes 백로그 4). Tier 1은
"false-nag 구조 담당"(planning-notes: "Tier 1 only reviews Tier-0 DRIFTs
(false-nag rescue)")인데 그 구조가 17% 확률로 무단 결근하는 셈이다.

### FD-5. 일반 제목의 목표 부합 페이지 — Tier 1도 증거가 없음

한 단어 제목("GitHub", "Overleaf"), 로그인/대시보드, 도구성 페이지는 r0가
낮고, Tier 1이 받는 것도 그 제목+호스트뿐이라 구제가 어렵다. 실측:
"전화번호를 입력하세요" 같은 무의미 제목이 반대 방향(저마진 OK)으로도 새는
등 generic 제목은 양방향 오판원이다 (judgment-audit-plan.md "Claude and AI
Tools", "Title Quality Is Not Guaranteed").

### FD-6. Tier 1 recent 리스트의 자기 강화 바이어스

페이로드의 최근 5건 (제목, verdict) 쌍은 **Tier 0/1의 자체 판정**이다
(`tier1_payload.py:27-32`, `sqlite.py:3447-3477` — 페이지 라벨만 반영, 원
판정이 오판이면 오판이 그대로 실림). 세션 초반 false-DRIFT가 연속되면 LLM은
"이 사용자는 계속 드리프트 중"이라는 맥락을 받고 동조할 유인이 있다. 정량
근거는 없음(미확인) — 그러나 프롬프트에 recent의 지위(참고용/판정 아님)에
대한 지시가 없다는 것은 사실 (`openai_compatible.py:40-47`).

### FD-7. Tier 1 DRIFT의 r_final=0.0 고정 — 근소 미달도 완전 이탈로 기록

`relevance.py:15-20`: Tier 1 DRIFT는 r0가 0.55든 0.05든 `r_final=0.0`으로
대체된다. streak 모드에는 영향 없지만 alignment 모드에서는 EWMA를 실제보다
빠르게 끌어내려 개입을 앞당긴다 — 주석 스스로 "0.15로 매핑하면 theta_low에
근접만 하고 arm이 안 된다"고 의도를 밝히고 있으나, 이는 근소 미달 페이지와
명백한 이탈 페이지를 구분하지 않는 설계다. (알고리즘 자체는 A안 재설계 별도
과제와 겹치므로 여기서는 신호 해상도 문제로만 기록.)

### FD-8. cold-start 구간

세션 초반은 anchor 없음 + exemplar는 목표 seed뿐 + enrichment는 비동기
지연 중. `coldstart_observations=5`가 **개입**은 막지만
(`streak.py:25-26`) verdict 기록 자체는 막지 않으므로, 초반 false-DRIFT가
recent 리스트(FD-6)·통계·리포트에 남는다. 실측: LG그램 세션 cold-start
false-DRIFT ×6.

### FD-9. 민감 도메인 드랍이 만드는 관측 공백과 streak 관통

`configs/sensitive_domains.json`의 키워드 매칭은 호스트 부분 문자열이라
과포괄이다 — "health"는 healthline.com류 정보 사이트, "auth"는 oauth/author
계열 서브도메인까지 드랍한다 (`domain_filter.py:47-50`). 드랍된 페이지는
관측 자체가 없으므로 (`ingest.py:49-58`) OK로 streak를 리셋하지도 못한다:
드리프트 2연속 → 목표 부합 작업을 docs.google.com(blocked_hosts)에서 30분 →
복귀 후 무관 페이지 1건이면 k=3 충족. 사용자 체감상 "방금까지 일했는데
잔소리"가 되는 false-drift성 개입이다. 미확인: 실제 발생 빈도.

### FD-10. 단일 고정 τ의 목표 간 비이식성

`tau_ok=0.6`은 200쌍 벤치마크에서 교차검증 없이 고른 잠정값
(`configs/default.yaml:63-66` 주석). 짧고 넓은 목표("공부", "리서치")는 관련
페이지 유사도 분포 자체가 낮게 깔릴 수 있는데 τ는 목표와 무관하게 고정이다.
목표별 분포 실측 근거 없음(미확인) — 계측 항목으로 제안(5절).

---

## 4. 개선안 (우선순위 / 비용 포함)

비용 축: 지연(판정 경로 추가 대기), LLM 호출 수(클라우드 쿼터·타임아웃 노출),
프라이버시(기기 밖으로 나가는 데이터). 원칙: audit plan의 기존 설계 결정
(conflict dictionary 금지, Tier 1 `uncertain` 금지, Tier 2 rare 유지)을
존중한다.

### P0 — 구조적이고 즉효

**A1. Tier 0 OK 감사 밴드 + 감사 트리거 (audit plan Step 3–5의 ONNX 재보정
구현)** — 대상: FO-1, FO-2, FO-3, FO-5.
`tau_ok <= r0 < audit_ok_below`인 저신뢰 OK, anchor 경로 단독 OK
(`exemplar_score < anchor_epsilon`인 OK — 플래그는 이미
`features.anchor_eligible`로 존재), 파생 문구 단독 OK(FO-2의 0.6–0.82 대역
대응이 핵심 — 파생 매치로 넘어온 OK는 r0 절대값과 무관하게 감사 대상),
동일 호스트 패밀리에 OK/DRIFT 혼재(mixed-host) 시 Tier 1 재심.
비용: Tier 1 호출 증가(감사 대상 비율만큼; 세션 학습이 진행되면 감소해야
정상 — 이 감소율 자체가 audit plan의 건강 지표), 지연은 DRIFT 재심과 동일
(10s 타임아웃 내), 프라이버시 변화 없음(동일 최소화 페이로드).
주의: `audit_ok_below` 값은 ONNX 스케일 라벨 히스토그램에서 도출해야 하며
(addendum이 hash-era 수치 재사용을 명시적으로 금지), 파생-단독-OK 감사는
임계값 없이도 켤 수 있어 선행 가능.

**A2. title quality 게이트 (`title_quality.py`, audit plan Step 2)** —
대상: FO-4, FO-7, FD-5(부분).
`content_specific / generic / url_like / empty` 분류. generic/url_like는
(a) exemplar 등록 차단 또는 감쇠(관련 있어요 클릭은 기록하되 학습은 조건부 —
audit plan Open Q2의 기존 결정), (b) anchor 어드미션 차단, (c) Tier 0 OK면
감사 트리거. 비용: 순수 로컬 규칙, 지연·호출·프라이버시 0. 오분류 리스크만
있으므로 replay로 분류기 자체를 검증.

**A3. 열화 상태의 판정 정책 연동** — 대상: FD-2, FD-4.
현재 열화는 표시만 되고 판정은 그대로 약화 동작한다. Tier 1 불능/타임아웃
연속·enrichment 실패 상태에서는 (a) Tier 0 단독 DRIFT의 컨트롤러 기여를
보수화(예: coldstart 연장 또는 개입 임계 상향)하고 (b) Tier 1 타임아웃은
1회 재시도(다음 키 로테이션은 이미 있음 — `ordered_api_keys`,
`providers/judges/base.py:118-136`) 또는 `timeout_seconds` 상향(백로그 4의
기존 옵션). 비용: 재시도만큼 호출 증가, 로직 소폭. "판정 못 하면 잔소리도
보수적으로"는 제품 신뢰 원칙(false-positive nagging 최우선 방지 — roadmap
전제)과 일치한다.

### P1 — 신호 품질

**B1. Tier 1 페이로드/프롬프트 보강 (audit plan Step 7)** — 대상: FD-6,
FO-5, FO-9.
(a) `audit: {trigger, tier0_score, exemplar_score, derived_score}` 첨부 —
LLM이 "Tier 0이 왜 넘겼는지"를 알게 함. (b) recent 리스트의 verdict에
"시스템 추정치이며 판정 근거가 아님"을 프롬프트에 명시하거나 verdict를 빼고
제목만 전달. (c) 두 프로바이더 프롬프트를 단일 상수로 통일(현재
openai_compatible에만 있는 subtopics 문장의 의도 확정 필요 — 6절).
(d) audit-OK 재심용 프롬프트에는 "같은 플랫폼이라는 사실만으로 OK 아님,
확인된 exemplar는 예시이지 도메인 허가가 아님" 문구(Step 7 원안).
비용: 토큰 소량 증가, 호출 수 불변, 프라이버시 불변(점수는 파생값).

**B2. negative exemplar 로깅 (audit plan Step 6, 로깅만)** — 대상: FO-2,
FO-5의 차기 대응 기반.
Tier 1 DRIFT / Tier 2 confirm / 사용자 accepted·drift 라벨을 후보로 기록
(title quality 게이트 통과분만). 스코어링 변경 없음 → 행동 리스크 0, 비용 0.
다음 마일스톤에서 contested-zone 감사 트리거("양쪽 다 가까움 → 감사")의
데이터 기반이 된다. 현재 `drift` 라벨은 컨트롤러 상태만 고치고 표현 학습에
아무것도 남기지 않는다 (`page_labels.py:49-62` — related만 exemplar 추가).

**B3. Tier 1 결과의 신뢰도 보존** — 대상: FO-6, FD-7.
0.85/0.0 이항 대체 대신 최소한 (verdict, tier, r0)를 보존해 컨트롤러가
가중할 수 있게 한다(예: Tier 1 OK가 streak를 리셋하는 대신 1 감소, Tier 1
DRIFT는 `min(r0, theta_low - ε)` 기록). 구체 가중은 A안 재설계·시간 조건
재설계(별도 과제)와 접점이 크므로 **여기서는 신호 보존까지만** 제안하고 정책
결정은 해당 과제로 넘긴다. 비용: 0 (저장 스키마에 r0는 이미 있음).

### P2 — 커버리지 보완

**C1. OK 페이지 장기 체류 재판정** — 대상: FO-8.
D7 heartbeat(이미 존재, `background.ts:440-462`)를 이용해 OK 판정 페이지도
체류 N분마다 현재 `tab.title` 재임베딩 → 제목이 실질 변경됐을 때만 재판정.
비용: 로컬 임베딩 1회/주기, LLM 0(DRIFT로 바뀔 때만 기존 경로), 프라이버시 0.

**C2. 민감 도메인 드랍의 컨트롤러 중립화** — 대상: FD-9.
드랍 시점에 verdict 없는 "관측 공백" 마커를 남겨 streak/클록이 공백을 관통해
누적되지 않게 하거나, 드랍 N분 경과 시 streak 감쇠. 키워드 리스트
과포괄("health", "auth")도 서브도메인 한정 등으로 정밀화. 비용: 0, 단
드랍 이벤트 기록은 이미 존재(`record_dropped_observation`)하므로 소규모.

**C3. 목표별 τ 진단** — 대상: FD-10.
τ 자동화 이전에, 세션별 r0 분포(라벨 없이도 이봉성/저분산 여부)를 리포트에
노출해 "이 목표는 Tier 0이 분리 못 하고 있음"을 가시화. 비용: 0.

**비권장/보류**: Tier 1을 모든 관측에 호출(비용·프라이버시 모델 붕괴),
Tier 1 `uncertain` 도입(기존 설계 결정 위반), 정적 conflict dictionary(기존
결정 위반), Tier 2를 Tier 1 대체로 승격(rare 원칙 위반).

---

## 5. 계측·검증 방안

측정 인프라는 이미 절반 존재한다 — 활용이 관건.

1. **Replay CLI가 이미 false_ok/false_drift를 센다**: 페이지 라벨 대비
   `verdict_replay`로 `labels.false_ok / false_drift` 집계, Tier 1 호출 수,
   OK↔DRIFT flip, verdict×label 히스토그램까지
   (`apps/server/app/replay/core.py:880-924`). CSV에 `hand_label`,
   `title_quality` 수기 라벨 컬럼도 준비돼 있다 (`core.py:95-98, 455-463`).
   **부족한 것**: (a) tier_reached별 혼동행렬(Tier 0 종결 vs Tier 1 경유
   분리 집계), (b) r0 구간별(0.1 단위) 라벨 히스토그램 — `audit_ok_below`
   선정의 직접 입력, (c) 세션 시간축 Tier 1 호출률(학습 건강 지표). 셋 다
   replay 출력 확장으로 충분.
2. **온라인 프록시 지표** (라벨 없이 상시 수집):
   - 페이지 라벨 override율 = `related` 라벨(=false-drift 정정)과 `drift`
     라벨(=false-ok 정정) 건수 / 관측 수. 원본 verdict가 불변 보존되는 D8
     설계 덕에 사후 집계 가능 (`sqlite.py:19-25`).
   - Tier 1 반전율(Tier 0 DRIFT → Tier 1 OK 비율): 높으면 Tier 0 false-drift
     과다, 0에 가까우면 Tier 1 무용 의심. `tier1_reason`·verdict는 이미 저장
     (`ingest.py:121-127`).
   - Tier 1 오류율: `record_tier1_provider_error` 이미 존재
     (`ingest.py:109-114`) — 시간창별 비율로 `/health`·리포트에 노출.
   - 개입 직후 피드백 분해: accepted(참) vs related(거짓 잔소리) 비율.
3. **라벨링 절차**: 도그푸딩 세션마다 replay CSV를 내려 `hand_label`
   (true_ok/false_ok/true_drift/false_drift)과 `title_quality`를 수기 기입 →
   사설 코퍼스(`KIBITZER_AUDIT_CORPUS`)에 축적. 단, 기존 코퍼스 회귀 기준치
   (false-DRIFT ≤ 30 등)는 hash-era 수치라 ONNX 스케일로 재도출 필요
   (addendum 명시).
4. **개선안 게이트**: A1/A2 도입 전후를 동일 세션 replay로 비교 —
   false_ok 감소량, false_drift 비악화, Tier 1 호출 증가량(예: 세션당 +30%
   상한), true-OK 유지율을 합격 조건으로 명문화. `--override`로 설정 스윕이
   가능하므로 (`replay/core.py:37-41`) `audit_ok_below` 후보를 격자 탐색.
5. **주의**: 이번 분석 시점의 로컬 DB는 비어 있었다. 계측 논의의 전제로
   "도그푸딩 세션 로그를 지우지 않고 보존"하는 운영 습관(또는 세션 종료 시
   replay CSV 자동 스냅숏)이 선행돼야 한다.

---

## 6. 미해결 질문

1. **`audit_ok_below`의 ONNX 스케일 값** — 라벨 히스토그램 없이는 결정 불가
   (audit plan Open Q4의 기존 입장 유지). 파생-단독-OK는 0.6–0.82에 분포하여
   단일 상한으로 못 잡을 가능성 — "파생 경로 OK는 값과 무관하게 감사"가
   맞는지 실측 필요.
2. **Tier 1 모델(`cheap-classifier`/nemotron 계열)의 실제 정확도** — 저장된
   `tier1_reason`·반전율 데이터가 현재 없어(빈 DB) 미확인. Tier 1 자체가
   false-ok의 순생산자인지 순구제자인지가 A1(감사 밴드에 Tier 1을 더 태우는
   안)의 기대효과를 좌우한다.
3. **openai_compatible 프롬프트의 "normal subtopics as ok" 문장** — 의도된
   관대함인지 프로바이더 간 드리프트인지 미확인. D7의 "useful side branch"
   개념(Tier 2)과의 역할 분담도 정리 필요.
4. **파생 문구 품질의 실LLM 검증** — addendum 수치는 수기 문구 프록시.
   실프로덕션 프롬프트로 생성된 문구의 recall/FPR 재측정 필요.
5. **드리프트 라벨(`drift`)의 학습 활용** — 현재 컨트롤러 정정만 하고 표현
   학습에는 미사용. negative exemplar(B2)로 넘길지, 프라이버시상 로깅 범위를
   어디까지 할지.
6. **FD-9(민감 도메인 공백의 streak 관통)의 실제 빈도** — 드랍 이벤트 로그와
   개입 시점의 교차 분석 필요. 시간 조건 재설계(별도 과제)와 해법이 겹칠 수
   있어 조율 필요.
7. **동일 URL 재판정(C1)의 재판정 주기와 D7 heartbeat 부하의 균형** — 별도
   과제(누적 드리프트 시간 조건 재설계)의 클록 설계와 함께 정해야 한다.

---

## 후속 (2026-07-21)

FO-9와 B1-c는 실행·검증 완료: Tier 1 프롬프트를 단일 상수로 통일하고
"normal subtopics" 문장을 삭제했으며, false-OK 억제 방향으로 엄격화했다.
실 프로바이더 3개 데이터셋 검증 결과와 미해결 질문 2·3의 실측 답은
[analysis-tier01-false-signals-conclusion.md](analysis-tier01-false-signals-conclusion.md) 참조.
나머지 제안(A1·A2·A3·B2·B3·C1-C3)은 미착수로 유효하다.

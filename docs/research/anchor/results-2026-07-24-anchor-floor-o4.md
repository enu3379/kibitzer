# Results — anchor floor O4/WASM 재보정 (2026-07-24)

[results-2026-07-21-anchor-pollution.md](results-2026-07-21-anchor-pollution.md)의
서버 시절 실험(오염 루프 재현·대책 비교·존폐)을 extension의 실제 런타임 스택
— **O4 ONNX 익스포트 + `WasmEmbeddingProvider`(onnxruntime-web WASM), τ=0.59,
β=0.85** — 에서 재실행한 결과다. 서버 시절 운영점 `0.30`은 O4 이전 익스포트
(τ=0.6 시절)의 분포에서 도출된 값이라 그대로 이식할 수 없다는 문제 제기에서
출발했다.

재현: `apps/extension`에서

```sh
node --experimental-strip-types tools/anchorFloorStudy.ts \
  ../../docs/benchmarks/tier0-embedding-o4/pair_scores.csv
```

임베딩은 프로덕션과 동일한 코드 경로(`src/providers/tier0Wasm.ts`)로 라이브
계산한다. sanity check: 재계산한 목표↔제목 코사인과 벤치마크 CSV의
`onnx_score` 최대 오차 0.0004.

## 1. 벤치마크 클러스터(200쌍)에서는 오염 루프가 재현되지 않는다

라벨 검수된 v3 벤치마크(40 클러스터 × 5쌍, #137로 보존)에 대해 클러스터별
최악 시나리오(첫 DRIFT 페이지를 Tier-1 false-OK로 강제 시드)를 시뮬레이션한
결과, **floor 0에서도 anchor발 연쇄 false-OK 0건, rescue 0건**.

원인: 이 벤치마크의 클러스터는 서로 다른 함정 유형(lexical_overlap_trap,
same_frame_trap, …)을 섞어 만든 것이라 페이지 간 자기유사성이 낮다. 오염
루프는 시드와 후속 페이지의 상호 코사인이 τ/β ≈ 0.694를 넘는 **자기유사
연속 방문**(정주행)에서만 발생한다 — 벤치마크가 측정하는 판정 정확도와는
독립적인 실패 모드다.

**rescue 0건은 서버 시절 결론(C1: anchor 구제 기여 없음)을 O4/WASM에서
재확인한다.** `ANCHOR_WINDOW = 0` 유지의 근거.

## 2. 정주행(자기유사) 시나리오에서 루프 재현 + floor 스윕

서버 시절 사고 유형을 본뜬 합성 정주행 런 4종(웹툰 회차 연속, 먹방 시리즈,
동일 상품 쇼핑 순회, 커뮤니티 스레드 순회) × 벤치마크 목표 40개 = 160개
조합. 각 조합에서 런의 첫 페이지를 Tier-1 false-OK로 강제 시드.

정주행 페이지 ↔ 목표 직접 유사도 분포 (1,040쌍):
`min 0.069 / p50 0.210 / p90 0.290 / p95 0.311 / p99 0.350 / max 0.450`

| floor | 시드 편입 | 연쇄 발생 조합 | 연쇄 false-OK |
|---|---|---|---|
| 없음(0) | 160/160 | 120 | **600** |
| 0.25 | 48 | 23 | 88 |
| **0.30 (서버 값)** | **15** | **6** | **15** |
| 0.35 | 1 | 1 | 2 |
| 0.40 | 1 | 1 | 1 |
| **0.45** | **0** | **0** | **0** |
| 0.50 | 0 | 0 | 0 |
| 0.55 | 0 | 0 | 0 |

- 루프는 O4/WASM에서도 실재한다: floor가 없으면 시드 한 번에 런 전체가
  연쇄 false-OK가 된다 (정주행 페이지 상호 코사인이 0.694를 쉽게 넘는다).
- **서버 시절 0.30은 O4 분포에서 뚫린다** (시드 15건, 연쇄 15건). O4에서
  정주행 유사도 꼬리(p99 0.350, max 0.450)가 0.30 위로 올라왔기 때문.
- 0.45가 첫 완전 차단점이지만 관측 최대치(0.450)와 사실상 맞닿아 있다.

## 3. 결정

- **`ANCHOR_WINDOW = 0` 유지** — rescue 0건 재확인. anchor는 켤 이유가
  없고, floor는 재활성화 시의 방어선으로만 존재한다.
- **`ANCHOR_TIEBREAK_FLOOR` / `TIER1_ANCHOR_FLOOR` = 0.30 → 0.50** —
  관측 최대 정주행 유사도 0.450 위에 마진을 둔 첫 라운드 값. 이
  스윕에서 비용 지표(rescue 손실)는 모든 floor에서 0이므로 상향은
  무비용이다.
- 한계: 벤치마크 OK 페이지의 약 절반이 직접 유사도 0.50 미만이라, anchor
  재활성화 시 floor 0.50은 그 페이지들의 anchor 편입을 막는다. rescue가
  0인 한 이는 비용이 아니지만, **재활성화를 검토한다면 합성 런이 아닌 실
  세션 로그 리플레이로 rescue/차단 트레이드오프를 다시 측정해야 한다**
  (그 시점의 재보정 절차도 `tools/anchorFloorStudy.ts` 재실행으로 시작).

같은 시기 문서: [handoff-2026-07-21-anchor-pollution.md](../../legacy/handoffs/handoff-2026-07-21-anchor-pollution.md)
(서버 시절 실험의 출발 질문), [results-2026-07-21-anchor-pollution.md](results-2026-07-21-anchor-pollution.md)
(서버 시절 결과 — 방법론의 원본).

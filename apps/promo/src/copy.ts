/**
 * Every line of copy in the video, in one place.
 *
 * Status legend:
 *   FIXED — confirmed by the user, do not change without asking.
 *   DRAFT — placeholder for the storyboard review; the tone is the point, not the words.
 *
 * Language split (confirmed): Kibitzer UI / nudges / goal / the user's own report are
 * Korean; the mock websites are English.
 */

/** FIXED */
export const GOAL = "쇼핑 플랫폼의 고객 유인 전략 분석 보고서 작성";
export const GOAL_BUDGET_MIN = "120";

export const nudge = {
  /** DRAFT — dry-spectator tone. Drift #1: direct messages. */
  first: {
    message: "대화가 대단히 활발하시군요. 보고서 목차엔 없는 항목입니다만.",
    context: "gramline.com - 다이렉트 메시지",
  },
  /** DRAFT — repeat offence, counts the interventions */
  second: {
    message: "오늘 2번째 관전평입니다. 꾸준함만은 인정합니다.",
    context: "gramline.com - 다이렉트 메시지",
  },
  /**
   * FIXED DIRECTION — the snooze callback. The second sentence lands the irony of the
   * whole piece (researching customer acquisition while being acquired) and can be cut.
   * NOTE: the shipping product resumes silently after a snooze expires; this beat is a
   * promotional assumption, agreed with the user.
   */
  third: {
    message: "5분만 시간을 달라시더니, 벌써 14분째인 건 아십니까? 장바구니는 7개가 되었고요.",
    context: "shop.daylight.co.kr - 장바구니",
  },
} as const;

/** DRAFT — celebration toast, shown on return. No buttons, sage border. */
export const praise = {
  message: "26분 만의 복귀입니다. 기록이라고는 못 하겠습니다만, 돌아오긴 하셨군요.",
} as const;

/** DRAFT — end card. Tone options are listed in storyboard.md. */
export const endCard = {
  wordmark: "Kibitzer",
  tagline: "당신의 목표를 지켜보는 조용한 훈수꾼",
  sub: "로컬에서 동작하는 주의력 가드 · Chrome 확장",
} as const;

/* ------------------------------------------------------------------ the report */

/**
 * One block of the document. The writing *schedule* (which block lands on which frame,
 * and whether it is typed or pasted) lives in scenes/script.ts — this file only owns
 * the words.
 */
export type DocBlock =
  /** `level: 2` is a numbered sub-heading (2.1, 3.4 …) — smaller, tighter than a section head. */
  | { t: "h"; text: string; level?: 1 | 2 }
  | { t: "p"; text: string }
  /** Enumerated items — research questions, caveats. Indented, no paragraph indent. */
  | { t: "list"; items: readonly string[] }
  /** Pasted from a source page — rendered with a rule and a provenance line. */
  | { t: "quote"; text: string; source: string }
  | { t: "gap" }
  | { t: "chart"; caption: string }
  /** The bibliography that closes the document. Small type, hanging indent. */
  | { t: "refs"; title: string; items: readonly string[] };

/**
 * The user's own report — Korean, matches the goal.
 *
 * Volume is a story beat here, not decoration: by the time attention wanders the document
 * has to look like an afternoon of real work, otherwise the drift costs nothing. It is
 * written as an actual undergraduate research paper would be — 서론 / 자료와 측정 틀 /
 * 분석 / 결론 / 참고 자료, numbered sub-headings, an operational definition for every
 * variable, and a caveats section that argues against its own findings. That structure is
 * what reads as *work* at a glance, before a single sentence has been parsed.
 *
 * Two classes of block make the volume possible, and their lengths are budgeted
 * differently:
 *
 *   ON CAMERA  — typed while the writing app is frontmost. An editor cut only affords
 *                5–16 frames per block, so at montage speed these top out around 40–60
 *                characters. Short, assertive, readable at a glance. Lengthening one is
 *                not free: `rateFor` in scenes/script.ts spreads a block over the gap
 *                before the next beat, so more characters means a faster crawl, and past
 *                RATE_MIN it stops reading as typing at all.
 *   OFF CAMERA — starts and finishes inside a stretch where the browser covers the
 *                writing app. Costs no screen time, so these carry the page count: the
 *                method, the cohort analysis, the caveats — the fifteen minutes the clock
 *                jumps, four times over.
 *
 * Which is which lives in `scenes/script.ts`; changing a block's length here means
 * re-checking its window there. `blocks` is written in DOCUMENT order, which is also the
 * order `WRITING` schedules them in — `scripts/doc-pages.mjs` relies on that to report
 * where the page breaks fall without having to load the whole scene graph.
 *
 * Every figure, source and hostname is invented, and consistent with what the mock pages
 * actually show — the dashboard rows in `StatsMock`, the article body in `NewsMock`. The
 * dashboard reports in dollars and the report is written in won, so §2.2 states the
 * conversion rather than letting the two units sit next to each other unexplained.
 */
export const report = {
  title: "쇼핑 플랫폼 고객 유인 전략 분석",
  subtitle: "획득 단가와 90일 잔존율의 상충 구조를 중심으로 · 리테일 커머스 리서치 2026",
  fileName: "shopping-platform-acquisition.pdf",
  blocks: {
    /* ============================================================ 1. 문제 정의 (서론) */
    s1h: { t: "h", text: "1. 문제 정의 — 신규 고객 획득 비용" },
    /** ON CAMERA — the first thing written, and the whole thesis in one sentence. */
    s1p1: {
      t: "p",
      text: "국내 쇼핑 플랫폼은 신규 고객 1인을 데려오는 데 월 활성 사용자당 매출의 3~4배를 쓴다.",
    },
    /** ON CAMERA */
    s1p2: {
      t: "p",
      text: "이 지출은 손익계산서에서 마케팅비 한 줄로 묶인다. 채널을 뜯어보면 이야기가 완전히 달라진다.",
    },
    /** OFF CAMERA — why the two numbers have to be read as a pair. */
    s1p3: {
      t: "p",
      text: "그래서 이 보고서는 획득 비용을 단일 지표로 보지 않고, 획득 시점의 단가와 90일 잔존율을 한 쌍으로 묶어 비교한다. 두 값을 함께 보지 않으면 어떤 채널이든 과대평가되거나 과소평가된다. 같은 1인당 5만 원이라도 90일 뒤 남아 있는 사람의 수는 채널에 따라 세 배까지 벌어지고, 그 차이는 획득 단가만 적힌 표에서는 끝내 드러나지 않는다.",
    },
    /** OFF CAMERA — the standard industry ratio, and why it does not rescue the problem. */
    s1p4: {
      t: "p",
      text: "실무에서 널리 쓰이는 LTV/CAC 비율도 이 문제를 해결하지 못한다. 분자인 생애 가치는 대부분 예측값이고, 그 예측 모형은 이미 잔존율을 입력으로 품고 있다. 잔존이 나쁜 채널일수록 생애 가치가 낮게 추정되어야 정상이지만, 실제로는 회수 기간을 짧게 잡는 방식으로 분모가 함께 줄어들면서 비율이 오히려 좋아 보이는 순환이 생긴다. 하나의 비율로 압축하는 순간 어떤 가정이 어디에 들어갔는지 추적할 수 없게 된다.",
    },
    /** OFF CAMERA — the gap in the prior work, stated as a gap. */
    s1p5: {
      t: "p",
      text: "선행 논의는 크게 두 갈래로 나뉜다. 한쪽은 채널 귀속의 정확도를 높이는 데 집중해 왔고, 다른 한쪽은 할인의 가격 탄력성을 추정해 왔다. 전자는 '누가 데려왔는가'에는 잘 답하지만 '데려온 다음에 어떻게 되었는가'는 묻지 않으며, 후자는 첫 구매 전환율까지만 종속변수로 삼는다. 두 갈래 모두 획득을 하나의 사건으로 취급한다는 점에서 같다. 이 보고서는 획득을 사건이 아니라 이후 90일의 행동을 규정하는 초기 조건으로 놓고, 수단의 선택이 그 조건을 어떻게 다르게 설정하는지를 본다.",
    },
    /** OFF CAMERA */
    s1p6: { t: "p", text: "이에 따라 다음 세 가지를 연구 질문으로 세운다." },
    /** OFF CAMERA — enumerated, because a paper enumerates. */
    s1rq: {
      t: "list",
      items: [
        "① 유인 수단별 획득 단가와 90일 잔존율 사이에는 어떤 상충 관계가 나타나는가.",
        "② 그 관계는 플랫폼의 거래액 규모와 취급 카테고리에 따라 어떻게 달라지는가.",
        "③ 세 수단을 대체재가 아니라 순서로 조합할 때 회수 구조는 실제로 개선되는가.",
      ],
    },

    /* ======================================================== 2. 자료와 측정 틀 (방법) */
    s2h: { t: "h", text: "2. 자료와 측정 틀" },
    s2h1: { t: "h", level: 2, text: "2.1 분석 대상과 관측 기간" },
    /** OFF CAMERA */
    s2p1: {
      t: "p",
      text: "측정 구간은 2025년 4분기부터 2026년 1분기까지 여섯 달이고, 대상은 월 거래액 기준 상위 12개 종합·버티컬 쇼핑 플랫폼이다. 카테고리 편중을 줄이기 위해 종합 5곳, 패션 4곳, 식품·생필품 3곳으로 구성했고, 각 군에서 거래액 1위 사업자와 중위 사업자를 함께 포함했다. 관측 단위는 플랫폼–가입월 코호트이며, 72개 코호트에서 신규 가입 118만 건이 관측되었다. 코호트당 표본 오차는 ±1.8%p 수준이다.",
    },
    s2h2: { t: "h", level: 2, text: "2.2 변수의 조작적 정의" },
    /** OFF CAMERA — the paragraph that makes every later number comparable. */
    s2p2: {
      t: "p",
      text: "신규 가입 이후 첫 주문까지를 획득으로, 첫 주문 이후 90일 안의 재주문을 잔존으로 정의했다. 획득 단가는 해당 채널에 직접 귀속되는 매체비와 할인·적립 원가의 합을 그 채널의 첫 주문 건수로 나눈 값이다. 광고 노출만으로 유입된 트래픽은 계정 생성 시점이 특정되지 않아 표본에서 제외했고, 앱을 다시 설치한 경우도 동일 계정이면 신규로 세지 않았다. 플랫폼마다 다르게 쓰이는 '신규'라는 말을 한 번은 통일해 두기 위한 것으로, 이후의 모든 수치는 이 기준 위에서만 비교할 수 있다. 원자료가 달러로 표기된 항목에는 관측 기간 평균 환율 1,320원을 적용해 환산했다.",
    },
    s2h3: { t: "h", level: 2, text: "2.3 측정상의 유의점" },
    /** OFF CAMERA — arguing against your own result is what makes it look like a paper. */
    s2p3: {
      t: "p",
      text: "세 가지는 미리 밝혀 둔다. 첫째, 채널 귀속은 각 플랫폼이 자체 보고한 라스트 터치 기준을 그대로 받았으므로, 큐레이션처럼 노출이 앞서고 전환이 늦는 수단은 구조적으로 과소 계상된다. 둘째, 멤버십 채널의 획득 단가에서 구독료 수입은 차감하지 않았다. 셋째, 관측 기간이 여섯 달이어서 마지막 두 코호트의 90일 잔존율은 절단된 값이다. 세 가지 모두 멤버십과 큐레이션에 불리한 방향으로 작용하므로, 아래에서 확인되는 격차는 보수적으로 읽어도 무방하다.",
    },
    s2h4: { t: "h", level: 2, text: "2.4 기술 통계" },
    /** OFF CAMERA — the dispersion, which is the actual finding of this section. */
    s2p4: {
      t: "p",
      text: "여섯 달 동안 관측된 획득 비용의 중앙값은 1인당 48,600원이었다. 다만 분포는 평균 주변에 모여 있지 않았다. 상위 4개 플랫폼은 3만 원대에서 신규 고객을 데려왔고, 하위 4개는 7만 원을 넘겼다. 같은 카테고리에서 같은 분기에 같은 광고 인벤토리를 쓰는데도 그렇다. 사분위 범위는 29,000원에서 71,000원까지 벌어지며, 이는 중앙값 하나로 업계 평균을 말하는 관행이 사실상 아무것도 설명하지 못한다는 뜻이다.",
    },
    /** OFF CAMERA — the lead-in the pasted table lands under. */
    s2p5: {
      t: "p",
      text: "차이를 만든 것은 입찰 단가가 아니라 유입 이후 첫 주문까지의 경로 길이였다. 경로가 세 단계를 넘어가는 순간 획득 비용은 예외 없이 두 배 가까이 뛰었고, 첫 화면에서 곧바로 장바구니로 이어지는 구조에서는 광고비를 늘려도 단가가 크게 흔들리지 않았다. 경로 길이를 통제한 뒤에도 수단 사이의 격차는 그대로 남았으므로, 이하에서는 경로를 통제 변수로 두고 수단 자체의 효과만 본다. 채널별 요약치는 [자료 1]과 같다.",
    },
    /** Pasted out of the analytics dashboard — all four rows of the channel table. */
    s2q: {
      t: "quote",
      text:
        "Coupon — first order · CAC $52.80 · D90 21.4% · ROI 0.74x\n" +
        "Referral credit · CAC $34.90 · D90 39.8% · ROI 1.31x\n" +
        "Editorial curation · CAC $21.60 · D90 49.7% · ROI 1.88x\n" +
        "Paid membership · CAC $42.10 · D90 77.2% · ROI 2.44x",
      source: "[자료 1] app.marketpulse.io — Channel detail (2026-08-04 조회)",
    },

    /* ============================================================== 3. 유인 수단 (분석) */
    s3h: { t: "h", text: "3. 유인 수단 — 쿠폰 · 멤버십 · 큐레이션" },
    /** ON CAMERA */
    s3p1: {
      t: "p",
      text: "쿠폰은 가장 즉각적인 수단이고, 가장 빨리 새는 수단이다. 두 성질은 같은 원인에서 나온다.",
    },
    s3h1: { t: "h", level: 2, text: "3.1 쿠폰 — 즉시성의 대가" },
    /** OFF CAMERA — the coupon cohort, in full. */
    s3p2: {
      t: "p",
      text: "가격을 이유로 온 사람은 가격을 이유로 떠난다. 첫 주문 할인은 몇 시간 안에 전환되지만, 할인으로 유입된 코호트의 이탈률은 다른 채널의 두 배에 가깝다. 쿠폰 채널의 90일 잔존율이 21.4%에 머무는 동안 멤버십 채널은 77.2%를 유지했고, 재주문 단가까지 얹으면 격차는 더 벌어진다. 손실의 대부분은 첫 3주에 몰려 있어, D14 시점에 이미 절반 이상이 사라진 뒤다.",
    },
    /** OFF CAMERA — the elasticity result, and the sentence that keeps it fair. */
    s3p3: {
      t: "p",
      text: "할인 폭을 키운 분기에는 첫 주문 수가 늘었지만 90일 잔존율은 오히려 3%p 떨어졌다. 표본 안에서 할인율과 잔존율의 상관계수는 -0.61로, 예산을 더 쓸수록 남는 사람의 비율은 낮아지는 관계가 관측된다. 쿠폰이 나쁜 수단이라는 뜻은 아니다. 다만 쿠폰으로 산 것은 고객이 아니라 첫 주문이며, 그 둘을 오랫동안 같은 줄에 적어 온 것이 문제라는 뜻이다.",
    },
    s3h2: { t: "h", level: 2, text: "3.2 멤버십 — 느린 전환, 긴 회수" },
    /**
     * Straddles the cut — starts on camera and finishes behind the browser window, which
     * is why it can be longer than the other typed blocks.
     */
    s3p4: {
      t: "p",
      text: "멤버십은 이 곡선을 뒤집는다. 가입 첫 달의 전환율은 쿠폰의 3분의 1 수준이고 획득 비용도 처음에는 더 크게 잡히지만, 결제 수단이 등록되고 배송비 면제가 습관이 되는 시점부터 재주문 간격이 눈에 띄게 짧아진다.",
    },
    /** OFF CAMERA — the reorder-interval numbers behind that claim. */
    s3p5: {
      t: "p",
      text: "전환 속도와 회수 기간이 정확히 반대로 움직이는 셈이다. 표본에서 멤버십 코호트의 평균 재주문 간격은 가입 첫 달 31일에서 3개월째 19일로 줄었고, 같은 기간 쿠폰 코호트는 34일에서 41일로 늘었다. 획득 단가만 보면 멤버십은 55,600원으로 쿠폰의 69,700원보다 이미 낮지만, 두 수단의 실제 격차는 단가가 아니라 이 간격에서 만들어진다. 회수 기준으로 멤버십의 손익 분기는 평균 4.1개월이었다.",
    },
    /** OFF CAMERA — the third source finally leaves a trace in the document. */
    s3q1: {
      t: "quote",
      text:
        "                D0 ·  D7 · D14 · D30 · D60 · D90\n" +
        "Membership     100 ·  94 ·  89 ·  84 ·  80 ·  77\n" +
        "Curation       100 ·  86 ·  74 ·  63 ·  55 ·  50\n" +
        "Referral       100 ·  79 ·  64 ·  51 ·  44 ·  40\n" +
        "Coupon         100 ·  61 ·  42 ·  30 ·  24 ·  21",
      source: "[자료 2] app.marketpulse.io — Retention cohorts, 지수 (D0 = 100)",
    },
    /** OFF CAMERA — reads the curve rather than the endpoint. */
    s3p6: {
      t: "p",
      text: "곡선의 모양도 다르다. 멤버십은 D7에서 94를 유지하며 완만하게 내려오지만, 쿠폰은 같은 시점에 이미 61까지 떨어진 뒤 기울기가 꺾인다. 잔존율의 차이는 마지막 값이 아니라 첫 2주의 기울기에서 결정되고, 그 기울기는 유인 수단이 정해지는 시점에 사실상 확정된다. 사후의 리텐션 캠페인이 이 기울기를 되돌린 사례는 표본에서 확인되지 않았다.",
    },
    s3h3: { t: "h", level: 2, text: "3.3 큐레이션 — 지연된 효과와 보이지 않는 비용" },
    /** OFF CAMERA — curation, and what "cheap" actually means here. */
    s3p7: {
      t: "p",
      text: "큐레이션은 세 수단 가운데 가장 느리지만 가장 싸다. 편집 콘텐츠를 통해 들어온 사용자는 첫 주문까지 평균 11일이 걸렸고, 그 사이 이탈률도 높았다. 대신 첫 주문을 마친 뒤의 행동은 멤버십 코호트와 거의 구분되지 않았다. D90 기준 49.7%는 유료 멤버십의 77.2%에 못 미치지만, 획득 단가가 28,500원으로 절반 수준이라는 점을 함께 놓으면 회수 배수는 1.88배로 네 채널 가운데 두 번째로 높다.",
    },
    /** OFF CAMERA — the accounting point, which is the section's real contribution. */
    s3p8: {
      t: "p",
      text: "매체비를 거의 쓰지 않는 채널이 잔존율에서 유료 채널을 따라잡는다는 사실은, 유인의 비용이 반드시 돈으로만 지불되지는 않는다는 뜻이다. 편집 인력과 촬영, 상품 선정에 드는 시간이 매체비를 대신할 뿐이고, 그 비용은 대개 어느 팀의 예산에도 잡히지 않는다. 큐레이션의 획득 단가가 낮아 보이는 이유의 일부는 실제로 싸기 때문이고, 나머지 일부는 회계에서 사라졌기 때문이다. 이 보고서의 수치도 후자를 보정하지 못했다.",
    },
    /**
     * OFF CAMERA — the threshold condition, which is also the first hint of §3.4's thesis.
     *
     * LENGTH IS LOAD-BEARING. This is the last paragraph before the two Enters, and it is
     * sized so that the written text fills page 4 to within a line of the bottom — which
     * is what pushes both blank lines onto a fresh page 5 and leaves the abandoned caret
     * alone there, the image the whole drift sequence is paid for with. Editing it means
     * re-running `node scripts/doc-pages.mjs`, which checks exactly that.
     */
    s3p9: {
      t: "p",
      text: "큐레이션에는 다만 성립 조건이 있다. 편집이 효과를 내려면 고를 것이 충분히 많아야 하고, 표본에서 그 임계는 취급 상품 수 기준 약 12만 개 부근이었다. 이 임계는 카테고리에 따라 다르게 나타났는데, 패션에서는 8만 개 수준에서도 편집의 효과가 확인된 반면 식품·생필품에서는 20만 개를 넘겨야 유의해졌다. 그 아래에서는 편집 콘텐츠가 상품 목록과 사실상 구분되지 않아 유입 자체가 발생하지 않았다. 대부분의 플랫폼이 이 조건을 충족하는 시점은 서비스 3년 차 전후였고, 그 이전에 큐레이션에 투입된 비용은 잔존율에 유의한 영향을 남기지 못했다. 유인 수단에도 도입 순서가 있다는 첫 번째 단서가 여기서 나온다.",
    },
    /** Pasted out of the trade-press article. */
    s3q2: {
      t: "quote",
      text: "\"The cheapest customer you will ever acquire is the one you already have.\"",
      source: "commerceweekly.com — Retail Desk",
    },
    /** ON CAMERA */
    s3p10: {
      t: "p",
      text: "오래 반복돼 온 문장이지만, 실제로 실천한 표는 드물다.",
    },
    /** ON CAMERA — the last thing written before attention goes. Typed four times slower. */
    s3p11: {
      t: "p",
      text: "세 수단은 순서의 문제일지도 모른다.",
    },
    /* --- everything below is written after the return --- */
    s3h4: { t: "h", level: 2, text: "3.4 소결 — 대체재가 아니라 순서" },
    /** OFF CAMERA — finishes the thought the drift interrupted. */
    s3p12: {
      t: "p",
      text: "세 수단을 같은 표에 놓고 하나를 고르는 문제로 보면 어느 것도 답이 되지 않는다. 쿠폰은 문을 열고, 큐레이션은 다시 올 이유를 만들고, 멤버십은 그 이유를 계약으로 바꾼다. 표본에서 회수 배수가 가장 높았던 세 플랫폼은 모두 이 순서를 지켰고, 세 수단을 동시에 최대 예산으로 집행한 플랫폼은 예외 없이 블렌디드 단가가 상승했다.",
    },
    /** OFF CAMERA — and the reason the finding is not yet a claim. */
    s3p13: {
      t: "p",
      text: "다만 순서 가설은 이 자료만으로 검정되지 않는다. 순서를 지킨 플랫폼이 애초에 카탈로그 깊이와 물류 조건에서 앞서 있었을 가능성을 배제할 수 없기 때문이다. 확인하려면 같은 플랫폼 안에서 유입 시점만 다르게 배분한 준실험 설계가 필요하고, 이는 후속 과제로 남긴다.",
    },

    /* ========================================================== 4. 유인 이후 (규모별) */
    s4h: { t: "h", text: "4. 유인 이후 — 리텐션 조건" },
    /** OFF CAMERA */
    s4p1: {
      t: "p",
      text: "획득 단가와 90일 잔존율을 두 축으로 놓고 12개 플랫폼을 배치하면, 규모 구간별로 서로 다른 조합이 나타난다. 거래액 상위 4개 플랫폼은 멤버십 단독으로 두 축을 모두 만족했다. 카탈로그가 이미 넓어 구독의 체감 가치가 확보되고, 물류 조건이 배송비 면제를 감당하기 때문이다. 중위 4개 플랫폼에서는 멤버십만으로 잔존율이 50%를 넘지 못했고, 큐레이션이 함께 집행된 경우에만 상위 구간에 근접했다.",
    },
    /** OFF CAMERA — the negative result, which is the honest half of the section. */
    s4p2: {
      t: "p",
      text: "하위 4개 플랫폼에서는 어떤 조합도 회수 배수 1.0을 넘기지 못했다. 이 구간의 제약은 유인 수단이 아니라 재고 회전과 배송 리드타임이었고, 잔존율의 분산도 수단보다 카테고리에 의해 더 크게 설명되었다. 유인 전략을 논의할 수 있는 최소 조건이 따로 있다는 뜻이며, 그 조건을 갖추지 못한 상태에서 늘린 마케팅비는 대부분 첫 주문에서 소진되었다.",
    },
    /** The figure closes §4 — a figure belongs to the section that analyses it. */
    chart: { t: "chart", caption: "[표 1] 유인 수단별 획득 단가 대비 90일 잔존율 · 12개 플랫폼 (2025Q4–2026Q1)" },

    /* ================================================================= 5. 결론 (S7) */
    s5h: { t: "h", text: "5. 결론 — 유인은 선택이 아니라 순서다" },
    /** ON CAMERA */
    s5p1: {
      t: "p",
      text: "두 축으로 놓고 보면 플랫폼 규모별 조합이 드러난다.",
    },
    /** ON CAMERA */
    s5p2: {
      t: "p",
      text: "상위 구간은 멤버십 단독으로 성립한다. 중위 구간은 큐레이션이 붙어야 한다.",
    },
    /** ON CAMERA */
    s5p3: {
      t: "p",
      text: "쿠폰은 어느 구간에서도 단독으로 회수되지 않았다. 문을 여는 데까지만 쓴다.",
    },
    /** The bibliography. Invented sources, matching the pages the film actually visits. */
    refs: {
      t: "refs",
      title: "참고 자료",
      items: [
        "[1] Commerce Weekly, Retail Desk. \"How Marketplaces Buy Their First Million Customers.\" 2026. — 41개 플랫폼 블렌디드 획득 비용, 2019년 지수화.",
        "[2] Commerce Weekly, Data Desk. \"Membership Retention Benchmarks, 2026.\" — 63개 플랫폼 수단별 D90 잔존율.",
        "[3] MarketPulse Analytics. Acquisition — Channel Breakdown; Retention Cohorts. 2026-08-04 조회.",
        "[4] 리테일커머스연구소. 「국내 종합몰 마케팅비 지출 구조 조사」. 2026.",
        "[5] 노라 서치 트렌드. 「검색 유입과 첫 주문까지의 경로」. 2026년 1분기.",
      ],
    },
  },
} as const satisfies { title: string; subtitle: string; fileName: string; blocks: Record<string, DocBlock> };

/* ------------------------------------------------------------------ mail + summary */

/** DRAFT — mail compose (English, per the plan; a Korean variant is noted in storyboard.md) */
export const mail = {
  to: "research-team@marketpulse.io",
  subject: "Report — Shopping Platform Customer Acquisition",
  body: [
    "Hi team,",
    "",
    "Attaching the acquisition-strategy report. Section 3 compares coupon,",
    "membership and curation funnels on cost vs. 90-day retention.",
    "",
    "Best,",
  ],
} as const;

/** Session summary — mirrors renderSummary() in popup.ts, including its composed strings. */
export const summary = {
  duration: "1시간 55분",
  observations: "63회",
  onGoal: "58%",
  interventions: "3회 · 수락 1회",
  topDrift: "shop.daylight.co.kr · 14회",
} as const;

/** Live dashboard readouts, shown just before the session is ended. */
export const dashboard = {
  pageTitle: "Membership Retention Benchmarks",
  pageHost: "commerceweekly.com",
  observations: "63",
  relatedRatio: "58%",
} as const;

/* ------------------------------------------------------------------ browser tabs */

/**
 * Browser tab titles. Site content is English per the confirmed language split; every
 * hostname is invented. The writing app is NOT a tab — it is a separate application.
 */
export const tabs = {
  news: "How Marketplaces Buy Their First Mil…",
  /** The results page the research keeps returning to between sources. */
  search: "marketplace customer acquisition …",
  stats: "Acquisition Analytics — Channels",
  /** Third source tab — the extra round trip in the research loop lands here. */
  cohorts: "Retention Cohorts — D90",
  insta: "다이렉트 메시지",
  /** Opened from a link someone drops in the DM thread. */
  music: "Paperlight — Neon Alley (Official MV)",
  portal: "러닝화 추천 : 통합검색",
  shopList: "오늘의 특가 · DAYLIGHT",
  shop: "장바구니 · DAYLIGHT",
  /** The new research topic picked up after the return. */
  research: "Membership Retention Benchmarks 2026",
  mail: "Inbox — New Message",
} as const;

/** Typed into the omnibox with autocomplete — only the first character is actually typed. */
export const omniSocial = { typed: "g", completion: "ramline.com", full: "gramline.com" } as const;
/** The new research query, typed out after the return. */
export const researchQuery = "membership retention benchmark 2026";

/** The writing application. Generic name — no real product is depicted. */
export const editorApp = {
  name: "Writer",
  documentName: "shopping-platform-acquisition",
} as const;

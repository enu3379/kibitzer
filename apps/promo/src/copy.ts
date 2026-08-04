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
  | { t: "h"; text: string }
  | { t: "p"; text: string }
  /** Pasted from a source page — rendered with a rule and a provenance line. */
  | { t: "quote"; text: string; source: string }
  | { t: "gap" }
  | { t: "chart"; caption: string };

/**
 * The user's own report — Korean, matches the goal.
 *
 * Volume is a story beat here, not decoration: by the time attention wanders the document
 * has to look like three pages of real work, otherwise the drift costs nothing. Two
 * classes of block make that possible, and their lengths are budgeted differently:
 *
 *   ON CAMERA  — typed while the writing app is frontmost. An editor cut only affords
 *                10–16 frames per block, so at montage speed these top out around 40–60
 *                characters. Short, assertive, readable at a glance.
 *   OFF CAMERA — starts and finishes inside a stretch where the browser covers the
 *                writing app. Costs no screen time, so these carry the page count: 300+
 *                characters of method and findings, the fifteen minutes the clock jumps.
 *
 * Which is which lives in `scenes/script.ts`; changing a block's length here means
 * re-checking its window there.
 */
export const report = {
  title: "쇼핑 플랫폼 고객 유인 전략 분석",
  subtitle: "리테일 커머스 리서치 · 2026",
  fileName: "shopping-platform-acquisition.pdf",
  blocks: {
    /* -------------------------------------------------------------- 1. 문제 정의 */
    h1: { t: "h", text: "1. 문제 정의 — 신규 고객 획득 비용" },
    /** ON CAMERA — the first thing written, and the whole thesis in one sentence. */
    p1: {
      t: "p",
      text: "국내 쇼핑 플랫폼은 신규 고객 1인을 데려오는 데 월 활성 사용자당 매출의 3~4배를 쓴다.",
    },
    /** ON CAMERA */
    p2: {
      t: "p",
      text: "이 지출은 손익계산서에서 마케팅비 한 줄로 묶인다. 채널을 뜯어보면 이야기가 완전히 달라진다.",
    },
    /** OFF CAMERA — why the two numbers have to be read as a pair. */
    p3: {
      t: "p",
      text: "그래서 이 보고서는 획득 비용을 단일 지표로 보지 않고, 획득 시점의 단가와 90일 잔존율을 한 쌍으로 묶어 비교한다. 두 값을 함께 보지 않으면 어떤 채널이든 과대평가되거나 과소평가된다. 같은 1인당 5만원이라도 90일 뒤 남아 있는 사람의 수는 채널에 따라 세 배까지 벌어지고, 그 차이는 획득 단가만 보는 표에서는 끝내 드러나지 않는다.",
    },
    /** OFF CAMERA — method. */
    p4: {
      t: "p",
      text: "측정 구간은 2025년 4분기부터 2026년 1분기까지 여섯 달이고, 대상은 월 거래액 상위 12개 플랫폼이다. 신규 가입 후 첫 주문까지를 획득으로, 첫 주문 이후 90일 안의 재주문을 잔존으로 정의했다. 광고 노출만으로 유입된 트래픽은 계정 생성 시점이 특정되지 않아 표본에서 제외했고, 앱을 다시 설치한 경우도 동일 계정이면 신규로 세지 않았다. 플랫폼마다 다르게 쓰이는 '신규'라는 말을 한 번은 통일해 두기 위한 것으로, 이후의 모든 수치는 이 기준 위에서만 비교할 수 있다. 표본 오차는 코호트당 ±1.8%p 수준이다.",
    },
    /** OFF CAMERA — the finding, and what actually explains the spread. */
    p5: {
      t: "p",
      text: "여섯 달 동안 관측된 획득 비용의 중앙값은 1인당 48,600원이었다. 다만 분포는 평균 주변에 모여 있지 않았다. 상위 4개 플랫폼은 3만원대에서 신규 고객을 데려왔고, 하위 4개는 7만원을 넘겼다. 같은 카테고리에서 같은 분기에 같은 광고 인벤토리를 쓰는데도 그렇다. 차이를 만든 것은 입찰 단가가 아니라 유입 이후 첫 주문까지의 경로 길이였다. 경로가 세 단계를 넘어가는 순간 획득 비용은 예외 없이 두 배 가까이 뛰었고, 첫 화면에서 바로 장바구니로 이어지는 구조에서는 광고비를 늘려도 단가가 크게 흔들리지 않았다.",
    },
    /** Pasted out of the analytics dashboard — all four rows of the channel table. */
    q1: {
      t: "quote",
      text:
        "Coupon — first order · CAC $52.80 · D90 21.4% · ROI 0.74x\n" +
        "Referral credit · CAC $34.90 · D90 39.8% · ROI 1.31x\n" +
        "Editorial curation · CAC $21.60 · D90 49.7% · ROI 1.88x\n" +
        "Paid membership · CAC $42.10 · D90 77.2% · ROI 2.44x",
      source: "app.marketpulse.io — Channel detail",
    },

    /* -------------------------------------------------------------- 2. 유인 수단 */
    h2: { t: "h", text: "2. 유인 수단 — 쿠폰 · 멤버십 · 큐레이션" },
    /** ON CAMERA */
    p6: {
      t: "p",
      text: "쿠폰은 가장 즉각적인 수단이고, 가장 빨리 새는 수단이다. 두 성질은 같은 원인에서 나온다.",
    },
    /** OFF CAMERA — the coupon cohort, in full. */
    p7: {
      t: "p",
      text: "가격을 이유로 온 사람은 가격을 이유로 떠난다. 첫 주문 할인은 몇 시간 안에 전환되지만, 할인으로 유입된 코호트의 이탈률은 다른 채널의 두 배에 가깝다. 쿠폰 채널의 90일 잔존율이 21.4%에 머무는 동안 멤버십 채널은 77.2%를 유지했고, 재주문 단가까지 얹으면 격차는 더 벌어진다. 할인 폭을 키운 분기에는 첫 주문 수가 늘었지만 90일 잔존율은 오히려 3%p 떨어졌다.",
    },
    /**
     * Straddles the cut — starts on camera and finishes behind the browser window, which
     * is why it can be longer than the other typed blocks.
     */
    p8: {
      t: "p",
      text: "멤버십은 이 곡선을 뒤집는다. 가입 첫 달의 전환율은 쿠폰의 3분의 1 수준이고 획득 비용도 처음에는 더 크게 잡히지만, 결제 수단이 등록되고 배송비 면제가 습관이 되는 시점부터 재주문 간격이 눈에 띄게 짧아진다.",
    },
    /** OFF CAMERA — curation, and what "cheap" actually means here. */
    p9: {
      t: "p",
      text: "큐레이션은 세 수단 가운데 가장 느리지만 가장 싸다. 편집 콘텐츠를 통해 들어온 사용자는 첫 주문까지 평균 11일이 걸렸고, 그 사이 이탈률도 높았다. 대신 첫 주문을 마친 뒤의 행동은 멤버십 코호트와 거의 구분되지 않았다. 매체비를 거의 쓰지 않는 채널이 잔존율에서 유료 채널을 따라잡는다는 사실은, 유인의 비용이 반드시 돈으로만 지불되지는 않는다는 뜻이다. 편집 인력과 촬영, 상품 선정에 드는 시간이 매체비를 대신할 뿐이고 그 비용은 대개 어느 팀의 예산에도 잡히지 않는다.",
    },
    /** Pasted out of the trade-press article. */
    q2: {
      t: "quote",
      text: "\"The cheapest customer you will ever acquire is the one you already have.\"",
      source: "commerceweekly.com — Retail Desk",
    },
    /** ON CAMERA */
    p10: {
      t: "p",
      text: "오래 반복돼 온 문장이지만, 실제로 실천한 표는 드물다.",
    },
    /** ON CAMERA — the last thing written before attention goes. Typed four times slower. */
    p11: {
      t: "p",
      text: "세 수단은 순서의 문제일지도 모른다.",
    },

    /* -------------------------------------------------------------- 3. 유인 이후 (S7) */
    h3: { t: "h", text: "3. 유인 이후 — 리텐션 조건" },
    /** ON CAMERA */
    p12: {
      t: "p",
      text: "두 축으로 놓고 보면 플랫폼 규모별 조합이 드러난다.",
    },
    /** ON CAMERA */
    p13: {
      t: "p",
      text: "상위 구간은 멤버십 단독으로 성립한다. 중위 구간은 큐레이션이 붙어야 한다.",
    },
    /** ON CAMERA */
    p14: {
      t: "p",
      text: "쿠폰은 어느 구간에서도 단독으로 회수되지 않았다. 문을 여는 데까지만 쓴다.",
    },
    chart: { t: "chart", caption: "[표 1] 유인 수단별 획득 비용 대비 90일 잔존율" },
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

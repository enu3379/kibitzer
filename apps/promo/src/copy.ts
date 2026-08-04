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

/** The user's own report — Korean, matches the goal. */
export const report = {
  title: "쇼핑 플랫폼 고객 유인 전략 분석",
  subtitle: "리테일 커머스 리서치 · 2026",
  fileName: "shopping-platform-acquisition.pdf",
  blocks: {
    h1: { t: "h", text: "1. 문제 정의 — 신규 고객 획득 비용" },
    p1: {
      t: "p",
      text: "국내 주요 쇼핑 플랫폼은 신규 고객 1인을 확보하는 데 월 활성 사용자당 매출의 3~4배를 지출한다. 이 구조에서 획득 비용은 성장률이 아니라 잔존율로 회수된다.",
    },
    /** Pasted out of the analytics dashboard. */
    q1: {
      t: "quote",
      text: "Coupon — first order · CAC $52.80 · D90 21.4% · ROI 0.74x\nPaid membership · CAC $42.10 · D90 77.2% · ROI 2.44x",
      source: "app.marketpulse.io — Channel detail",
    },
    h2: { t: "h", text: "2. 유인 수단 — 쿠폰 · 멤버십 · 큐레이션" },
    p2: {
      t: "p",
      text: "쿠폰은 가장 즉각적인 수단이다. 첫 주문 할인은 몇 시간 안에 전환되지만, 할인으로 유입된 코호트의 이탈률은 다른 채널의 두 배에 가깝다.",
    },
    /** Pasted out of the trade-press article. */
    q2: {
      t: "quote",
      text: "\"The cheapest customer you will ever acquire is the one you already have.\"",
      source: "commerceweekly.com — Retail Desk",
    },
    p3: {
      t: "p",
      text: "멤버십은 이 곡선을 뒤집는다. 초기 전환은 느리고 비용은 크지만, 90일 잔존율은 카테고리 평균을 크게 웃돌았다.",
    },
    /** Written after the return (S7). */
    h3: { t: "h", text: "3. 유인 이후 — 리텐션 조건" },
    p4: {
      t: "p",
      text: "세 수단을 획득 비용과 90일 잔존율의 두 축으로 비교하면 플랫폼 규모별 최적 조합이 드러난다.",
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
  stats: "Acquisition Analytics — Channels",
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

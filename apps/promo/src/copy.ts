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
export const GOAL_BUDGET_MIN = "90";

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
  message: "복귀까지 14분. 기록적이라고는 하지 않겠습니다만, 나쁘지 않습니다.",
} as const;

/** DRAFT — end card. Tone options are listed in storyboard.md. */
export const endCard = {
  wordmark: "Kibitzer",
  tagline: "당신의 목표를 지켜보는 조용한 훈수꾼",
  sub: "로컬에서 동작하는 주의력 가드 · Chrome 확장",
} as const;

/** The user's own report — Korean, matches the goal. */
export const report = {
  title: "쇼핑 플랫폼 고객 유인 전략 분석",
  subtitle: "리테일 커머스 리서치 · 2026",
  /** Typed live in S2 (the outline). Length is timed against beat.outlineTypeStart. */
  outline: ["1. 문제 정의 — 신규 고객 획득 비용", "2. 유인 수단: 쿠폰 · 멤버십 · 큐레이션"],
  /** Typed live in S6 (resuming after the return) */
  resumed: "3. 유인 이후: 리텐션 조건",
  /** Already-written body, visible in S7 */
  body: [
    "국내 주요 쇼핑 플랫폼은 신규 고객 1인을 확보하는 데 평균적으로",
    "월 활성 사용자당 매출의 3~4배를 지출한다. 이 구조에서 쿠폰은",
    "가장 즉각적인 수단이지만, 재구매로 이어지는 비율은 가장 낮았다.",
    "",
    "반면 멤버십 기반 유인은 초기 전환율이 낮은 대신 90일 잔존율에서",
    "뚜렷한 차이를 보였다. 본 보고서는 세 가지 유인 수단을 획득 비용과",
    "잔존율의 두 축으로 비교하고, 플랫폼 규모별 최적 조합을 제안한다.",
  ],
  fileName: "shopping-platform-acquisition.pdf",
} as const;

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
  duration: "52분",
  observations: "38회",
  onGoal: "71%",
  interventions: "3회 · 수락 1회",
  topDrift: "shop.daylight.co.kr · 9회",
} as const;

/** Live dashboard readouts, shown just before the session is ended. */
export const dashboard = {
  pageTitle: "Customer Acquisition — Channel Breakdown",
  pageHost: "app.marketpulse.io",
  observations: "38",
  relatedRatio: "71%",
} as const;

/**
 * Browser tab titles. Site content is English per the confirmed language split.
 * The writing app is NOT a tab — it is a separate application (see AppWindow).
 */
export const tabs = {
  /** Background music — open the whole time, and deliberately NOT closed in S5. */
  music: "Paperlight — Neon Alley (Official MV)",
  news: "How Marketplaces Buy Their First Mil…",
  stats: "Acquisition Analytics — Channels",
  insta: "다이렉트 메시지",
  portal: "러닝화 추천 : 통합검색",
  shop: "장바구니 · DAYLIGHT",
  mail: "Inbox — New Message",
} as const;

/** The writing application. Generic name — no real product is depicted. */
export const editorApp = {
  name: "Writer",
  documentName: "shopping-platform-acquisition",
} as const;

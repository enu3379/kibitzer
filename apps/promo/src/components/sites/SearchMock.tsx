import React from "react";

/**
 * Generic web search results.
 *
 * This exists so the research scene shows someone *finding* things. Bouncing between two
 * already-open tabs reads as fidgeting; going back to a results page, picking a different
 * source and opening it reads as work. Icon-only mark, invented hostnames throughout.
 */

export type SearchResult = {
  site: string;
  url: string;
  title: string;
  snippet: string;
};

/**
 * One set per search in the scene; the highlighted row is the one about to be clicked.
 *
 * The three queries are the report's three research questions in the order it asks them —
 * what the instruments cost, how cost trades against retention, and what the curve looks
 * like underneath. The rows that are *not* clicked are the two strands of prior work §1
 * says the literature splits into: attribution accuracy on one side, discount elasticity
 * on the other. Passing over them on the way to a third source is what makes §1's "두
 * 갈래 모두 획득을 하나의 사건으로 취급한다" read as a decision rather than an assertion.
 */
export const SEARCHES: ReadonlyArray<{
  query: string;
  results: readonly SearchResult[];
  pick: number;
  /** Bottom-of-page chips. They are where the *next* query in the scene comes from. */
  related: readonly string[];
}> = [
  {
    query: "marketplace customer acquisition cost benchmark",
    pick: 0,
    related: [
      "acquisition cost by channel 2026",
      "first order discount churn rate",
      "why LTV/CAC is circular",
      "last touch attribution bias",
    ],
    results: [
      {
        site: "commerceweekly.com",
        url: "commerceweekly.com › analysis › how-marketplaces-buy",
        title: "How Marketplaces Buy Their First Million Customers",
        snippet:
          "The cost of a first order runs three to four times monthly revenue per active user — and discount-acquired cohorts churn at nearly twice the rate of every other channel …",
      },
      {
        site: "retailops.io",
        url: "retailops.io › guides › attribution-windows",
        title: "Last touch, first touch, and what each one hides",
        snippet:
          "Tightening the attribution window improves apparent accuracy and systematically under-counts anything that converts slowly …",
      },
      {
        site: "thelanding.dev",
        url: "thelanding.dev › posts › discount-elasticity-2026",
        title: "Discount elasticity, re-estimated for 2026",
        snippet:
          "Every model here stops at the first purchase. Depth of discount predicts conversion well and predicts nothing after it …",
      },
    ],
  },
  {
    query: "channel level CAC vs D90 retention dashboard",
    pick: 1,
    related: [
      "D90 retention benchmark ecommerce",
      "membership payback period months",
      "steps to first order cost",
      "CAC won dollar conversion 2026",
    ],
    results: [
      {
        site: "retailops.io",
        url: "retailops.io › guides › ltv-cac-is-circular",
        title: "Why LTV/CAC cannot tell you what you want to know",
        snippet:
          "The numerator is a forecast and the forecast already takes retention as an input, so the ratio holds steady while the business does not …",
      },
      {
        site: "app.marketpulse.io",
        url: "app.marketpulse.io › acquisition › channels",
        title: "Acquisition Analytics — Channel Breakdown",
        snippet:
          "12 platforms · 72 monthly cohorts · 1.18M signups. CAC, D90 retention and ROI per instrument, with cost dispersion and steps to first order …",
      },
      {
        site: "commerceweekly.com",
        url: "commerceweekly.com › data › methodology",
        title: "How we count a new customer",
        snippet:
          "Signup to first order is the acquisition window; reinstalls on an existing account are not counted as new, and impression-only traffic is excluded …",
      },
    ],
  },
  {
    query: "membership cohort retention curve d90",
    pick: 2,
    related: [
      "retention slope first 14 days",
      "curation catalogue depth threshold",
      "cohort censoring incomplete D90",
      "membership retention benchmark 2026",
    ],
    results: [
      {
        site: "thelanding.dev",
        url: "thelanding.dev › posts › cohort-charts-that-lie",
        title: "Cohort charts that lie to you",
        snippet:
          "A single ninety-day number for a whole platform describes nothing, and a chart that hides its censored cohorts describes less …",
      },
      {
        site: "retailops.io",
        url: "retailops.io › guides › membership-payback",
        title: "Membership payback periods, measured",
        snippet:
          "Paid tiers convert at a third of the coupon rate and cost more up front, then break even near month four and keep going …",
      },
      {
        site: "app.marketpulse.io",
        url: "app.marketpulse.io › cohorts › retention",
        title: "Retention Cohorts — survival to D90",
        snippet:
          "Decay per instrument sampled at D0/7/14/30/60/90, discount depth against D90, and the monthly signup grid with incomplete cohorts marked …",
      },
    ],
  },
];

const Favicon: React.FC<{ site: string }> = ({ site }) => {
  const palette: Record<string, string> = {
    "commerceweekly.com": "#1f2937",
    "app.marketpulse.io": "#0f766e",
    "retailops.io": "#7c3aed",
    "thelanding.dev": "#b45309",
  };
  return (
    <span
      style={{
        width: 17,
        height: 17,
        borderRadius: 5,
        background: palette[site] ?? "#64748b",
        display: "grid",
        placeItems: "center",
        color: "#fff",
        fontSize: 9.5,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {site[0].toUpperCase()}
    </span>
  );
};

export const SearchMock: React.FC<{
  /** Index into SEARCHES. */
  set: number;
  /** Query text as typed so far. */
  query: string;
  /** Row about to be clicked — lifts and underlines, like a hover. */
  hot?: number | null;
}> = ({ set, query, hot = null }) => {
  const s = SEARCHES[set % SEARCHES.length];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#fff", overflow: "hidden" }}>
      {/* header: icon-only mark + the query box */}
      <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "16px 28px 12px", borderBottom: "1px solid #ebedef" }}>
        <svg width={28} height={28} viewBox="0 0 32 32" aria-hidden style={{ flexShrink: 0 }}>
          <circle cx="13" cy="13" r="9" fill="none" stroke="#4285f4" strokeWidth="3.4" />
          <path d="M20 20 L28 28" stroke="#34a853" strokeWidth="3.6" strokeLinecap="round" />
        </svg>
        <div
          style={{
            flex: 1,
            maxWidth: 560,
            height: 38,
            borderRadius: 999,
            border: "1px solid #dfe1e5",
            boxShadow: "0 1px 5px rgba(32,33,36,0.14)",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            fontSize: 13,
            color: "#202124",
          }}
        >
          {query}
          <span style={{ display: "inline-block", width: 1.4, height: 15, background: "#202124", marginLeft: 1 }} />
          <span style={{ marginLeft: "auto", color: "#4285f4", fontSize: 15 }}>⌕</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 26, padding: "6px 28px 0", fontSize: 11.5, color: "#5f6368", borderBottom: "1px solid #ebedef" }}>
        {["전체", "이미지", "뉴스", "동영상", "도서"].map((t, i) => (
          <span
            key={t}
            style={{
              padding: "8px 0 9px",
              color: i === 0 ? "#1a73e8" : "#5f6368",
              borderBottom: i === 0 ? "3px solid #1a73e8" : "3px solid transparent",
              fontWeight: i === 0 ? 600 : 400,
            }}
          >
            {t}
          </span>
        ))}
      </div>

      <div style={{ padding: "14px 28px", maxWidth: 660 }}>
        <div style={{ fontSize: 10.5, color: "#70757a", marginBottom: 12 }}>검색결과 약 1,240,000개 (0.31초)</div>
        {s.results.map((r, i) => (
          <div
            key={r.url}
            style={{
              marginBottom: 18,
              padding: hot === i ? "6px 10px" : "6px 0",
              marginLeft: hot === i ? -10 : 0,
              borderRadius: 8,
              background: hot === i ? "#f1f3f4" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 3 }}>
              <Favicon site={r.site} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10.5, color: "#202124", lineHeight: 1.2 }}>{r.site}</div>
                <div style={{ fontSize: 10, color: "#5f6368", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.url}
                </div>
              </div>
            </div>
            <div
              style={{
                fontSize: 17,
                lineHeight: 1.3,
                color: hot === i ? "#0b57d0" : "#1a0dab",
                marginBottom: 3,
                textDecoration: hot === i ? "underline" : "none",
              }}
            >
              {r.title}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: "#4d5156" }}>{r.snippet}</div>
          </div>
        ))}

        {/* Related searches. The last chip of set 3 is the query typed after the return —
            the research thread was already on the page before the drift interrupted it. */}
        <div style={{ marginTop: 10, paddingTop: 16, borderTop: "1px solid #ebedef" }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "#202124", marginBottom: 11 }}>관련 검색어</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
            {s.related.map((q) => (
              <span
                key={q}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "#f1f3f4",
                  borderRadius: 999,
                  padding: "8px 15px 8px 12px",
                  fontSize: 11.5,
                  color: "#202124",
                }}
              >
                <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
                  <circle cx="10" cy="10" r="7" fill="none" stroke="#5f6368" strokeWidth="2.6" />
                  <path d="M15 15 L21 21" stroke="#5f6368" strokeWidth="2.8" strokeLinecap="round" />
                </svg>
                {q}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

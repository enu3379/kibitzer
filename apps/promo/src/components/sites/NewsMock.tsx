import React from "react";
import { WINDOW } from "../../theme";

/**
 * Generic trade-press article. No real masthead, no real byline, every figure invented.
 *
 * These two pieces are the report's narrative sources — the dashboard supplies the
 * numbers, these supply the argument. Between them they carry every claim §1 and §3 make
 * that no dashboard could: the three-to-four-times figure, the circularity of LTV/CAC,
 * the two strands of prior work, the catalogue-depth threshold, and the size-band result
 * §4 is written directly after reading.
 *
 * A body is a list of blocks rather than a list of strings so the pull quote can be
 * placed exactly — the drag-select in CURSOR_PATH grabs it at fixed screen coordinates,
 * and the scroll that puts it there (`URL.news` handling in scenes/script.ts) is tuned to
 * QUOTE_SCROLL below. Adding a block above the quote in article 0 means re-tuning that
 * one number; `node scripts/render-stills.mjs s2-select-news` shows whether it landed.
 */

type Block =
  | { t: "p"; text: string }
  /** Three figures in a rule-bounded strip, the way a data desk pulls out its lede. */
  | { t: "stats"; items: ReadonlyArray<{ v: string; k: string }> }
  | { t: "table"; title: string; head: readonly string[]; rows: ReadonlyArray<readonly string[]>; note: string }
  /** The pull quote. Exactly one per article, and its position is load-bearing in #0. */
  | { t: "quote"; text: string };

type Article = {
  kicker: string;
  headline: string;
  desk: string;
  read: string;
  caption: string;
  body: readonly Block[];
};

const ARTICLES: readonly Article[] = [
  {
    kicker: "ANALYSIS",
    headline: "How Marketplaces Buy Their First Million Customers",
    desk: "Retail Desk",
    read: "12 min read",
    caption: "Blended acquisition cost across 41 platforms, indexed to 2019.",
    body: [
      {
        t: "p",
        text: "Every marketplace eventually meets the same wall. The first hundred thousand customers arrive on curiosity; the next million have to be bought. What separates the platforms that survive that transition is not how much they spend, but which instrument they reach for.",
      },
      {
        t: "p",
        text: "The spending is not marginal. Across the platforms we track, the cost of a first order now runs three to four times monthly revenue per active user, and it is booked as a single marketing line. Split that line by channel and the same budget describes four completely different businesses.",
      },
      {
        t: "stats",
        items: [
          { v: "3.4×", k: "cost of a first order, against monthly revenue per active user" },
          { v: "2.1×", k: "churn of discount-acquired cohorts vs. every other channel" },
          { v: "$36.80", k: "median cost of a first order, 41 platforms" },
        ],
      },
      {
        t: "p",
        text: "Coupons remain the fastest lever. A first-order discount converts within hours, which makes it irresistible to teams measured on weekly growth. But discount-acquired cohorts churn at nearly twice the rate of every other channel, and more than half of that loss lands inside the first fortnight — before anyone has run a single retention campaign.",
      },
      {
        t: "p",
        text: "The ratio most teams check will not catch this. Lifetime value over acquisition cost looks decisive until you notice that the numerator is a forecast, and that the forecast already takes retention as an input. A channel that retains badly gets a shorter assumed payback window, which shrinks the denominator too, and the ratio holds steady while the business underneath it does not.",
      },
      {
        t: "quote",
        text: "\"The cheapest customer you will ever acquire is the one you already have.\"",
      },
      {
        t: "p",
        text: "Membership programmes invert the curve. Conversion is slower and the upfront cost is higher, yet ninety-day retention holds far above the category average — buyers who pay for access behave as though they have already committed. Median payback lands near four months, against a coupon cohort that mostly never pays back at all.",
      },
      {
        t: "table",
        title: "Cost of a first order, indexed to 2019 = 100",
        head: ["INSTRUMENT", "2019", "2022", "2026", "D90"],
        rows: [
          ["Coupon — first order", "100", "148", "211", "21%"],
          ["Referral credit", "100", "121", "139", "40%"],
          ["Editorial curation", "100", "104", "86", "50%"],
          ["Paid membership", "100", "132", "168", "77%"],
        ],
        note: "41 platforms, nominal. Curation is the only instrument that got cheaper.",
      },
      {
        t: "p",
        text: "Curation sits between the two. Editorial feeds and personalised collections cost little per impression, but they only compound once catalogue depth crosses a threshold — around 120,000 listings in our sample, and most platforms reach it in year three. Fashion clears it earlier, near 80,000; grocery and household need more than 200,000 before editorial beats a plain listing page.",
      },
      {
        t: "p",
        text: "Route length explains more of the spread than bidding does. Where a landing page leads straight to a cart, extra ad spend barely moves the unit cost. Where it takes four steps, the cost of a first order roughly doubles, and no amount of creative testing has closed that gap in the data we hold.",
      },
      {
        t: "p",
        text: "One caveat runs through all of it. Almost every platform reports on last touch, which systematically under-counts anything that works slowly — curation most of all. Read against discount depth, the pattern is blunt: across our sample the correlation between first-order discount and ninety-day retention is minus zero point six one. Spending more buys more first orders and fewer customers.",
      },
    ],
  },
  {
    kicker: "DATA",
    headline: "Membership Retention Benchmarks, 2026",
    desk: "Data Desk",
    read: "9 min read",
    caption: "D90 retention by acquisition instrument and GMV quartile, 63 platforms.",
    body: [
      {
        t: "stats",
        items: [
          { v: "77%", k: "D90, members recruited through a paid tier" },
          { v: "21%", k: "D90, the same platforms' discount cohorts" },
          { v: "63", k: "platforms, six months, one definition of 'new'" },
        ],
      },
      {
        t: "p",
        text: "Retention benchmarks are usually quoted as a single number, which is how they end up meaning nothing. A ninety-day figure for a grocery platform and one for a fashion marketplace describe entirely different behaviours, and averaging them describes neither.",
      },
      {
        t: "p",
        text: "Segmenting by acquisition instrument fixes most of that. Members recruited through a paid tier hold at 77 percent; the same platform's discount cohort falls below a quarter by the same checkpoint, and almost all of that loss happens in the first three weeks. Segmenting by size fixes the rest — and it is the less comfortable half of the exercise.",
      },
      {
        t: "table",
        title: "By GMV quartile — what actually clears its cost",
        head: ["QUARTILE", "D90", "RECOVERY", "WORKING COMBINATION"],
        rows: [
          ["Top", "63–74%", "2.1×", "Membership alone"],
          ["Middle", "41–52%", "1.4×", "Membership + curation"],
          ["Bottom", "19–31%", "0.8×", "Nothing clears 1.0×"],
        ],
        note: "Coupons do not recover their cost as a standalone instrument in any quartile.",
      },
      {
        t: "p",
        text: "The bottom quartile is where the instrument stops being the variable. In that band the binding constraints are inventory turn and delivery lead time, and retention variance is explained better by category than by anything the marketing team chose. There is a floor of operational conditions below which the acquisition question cannot be asked at all, and budget added under that floor is spent almost entirely on first orders.",
      },
      {
        t: "quote",
        text: "\"Retention is not a number you report. It is the instrument you chose, six months ago.\"",
      },
      {
        t: "p",
        text: "The uncomfortable finding is how little the gap moves with spend. Doubling the coupon budget buys volume at the top of the funnel and almost nothing at the bottom, while a modest membership benefit moves the ninety-day line by double digits. In the quarters where platforms deepened their first-order discount, order counts rose and D90 fell three points.",
      },
      {
        t: "p",
        text: "Curation remains the hardest to benchmark, because its effect is delayed and shows up as a change in frequency rather than a change in cohort size — and because last-touch reporting hands the credit to whatever the customer clicked last.",
      },
    ],
  },
];

const COLUMN = 640;

const Body: React.FC<{ block: Block; selectQuote: number }> = ({ block, selectQuote }) => {
  switch (block.t) {
    case "p":
      return <p style={{ fontSize: 15, lineHeight: 1.78, color: "#1f2937", margin: "0 0 19px" }}>{block.text}</p>;
    case "stats":
      return (
        <div
          style={{
            display: "flex",
            gap: 22,
            margin: "4px 0 24px",
            padding: "16px 0",
            borderTop: "2px solid #0f172a",
            borderBottom: "1px solid #e5e7eb",
          }}
        >
          {block.items.map((s) => (
            <div key={s.k} style={{ flex: 1 }}>
              <div style={{ fontSize: 27, fontWeight: 750, letterSpacing: "-0.8px", color: "#0f766e", lineHeight: 1.1 }}>{s.v}</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#6b7280", marginTop: 5 }}>{s.k}</div>
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <div style={{ margin: "4px 0 24px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "#0f172a", marginBottom: 8, letterSpacing: "-0.1px" }}>
            {block.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 10.5,
              fontWeight: 700,
              color: "#6b7280",
              letterSpacing: "0.4px",
              paddingBottom: 7,
              borderBottom: "1.5px solid #0f172a",
            }}
          >
            {block.head.map((h, i) => (
              <span key={h} style={{ flex: i === 0 ? 2.1 : 1, textAlign: i === 0 ? "left" : "right" }}>
                {h}
              </span>
            ))}
          </div>
          {block.rows.map((r) => (
            <div
              key={r[0]}
              style={{
                display: "flex",
                fontSize: 13,
                padding: "9px 0",
                borderBottom: "1px solid #f1f3f5",
                color: "#1f2937",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {r.map((c, i) => (
                <span
                  key={i}
                  style={{
                    flex: i === 0 ? 2.1 : 1,
                    textAlign: i === 0 ? "left" : "right",
                    fontWeight: i === r.length - 1 ? 650 : 400,
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          ))}
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 8 }}>{block.note}</div>
        </div>
      );
    case "quote":
      return (
        <blockquote
          style={{
            margin: "26px 0",
            paddingLeft: 18,
            borderLeft: "3px solid #0f766e",
            fontSize: 18,
            lineHeight: 1.6,
            color: "#0f172a",
            fontWeight: 600,
            letterSpacing: "-0.2px",
          }}
        >
          <span
            style={{
              background: `rgba(172,206,247,${Math.max(0, Math.min(1, selectQuote))})`,
              boxDecorationBreak: "clone",
              WebkitBoxDecorationBreak: "clone",
            }}
          >
            {block.text}
          </span>
        </blockquote>
      );
  }
};

/**
 * `selectQuote` drives the drag-selection over the pull quote — the text has to look
 * picked up before a ⌘C means anything.
 */
export const NewsMock: React.FC<{ scroll: number; variant?: number; selectQuote?: number }> = ({
  scroll,
  variant = 0,
  selectQuote = 0,
}) => {
  const a = ARTICLES[variant % ARTICLES.length];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#fff", overflow: "hidden" }}>
      <div style={{ transform: `translateY(${-scroll}px)`, width: WINDOW.width }}>
        {/* masthead — icon only, no wordmark */}
        <div
          style={{
            borderBottom: "1px solid #e5e7eb",
            padding: "13px 0 11px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width={30} height={30} viewBox="0 0 32 32" aria-hidden>
            <rect x="1" y="1" width="30" height="30" rx="7" fill="#1f2937" />
            <rect x="7" y="9" width="18" height="2.6" rx="1.3" fill="#f9fafb" />
            <rect x="7" y="15" width="18" height="2.6" rx="1.3" fill="#9ca3af" />
            <rect x="7" y="21" width="11" height="2.6" rx="1.3" fill="#9ca3af" />
          </svg>
        </div>
        <div
          style={{
            borderBottom: "1px solid #f3f4f6",
            padding: "8px 0",
            display: "flex",
            justifyContent: "center",
            gap: 26,
            fontSize: 11,
            color: "#6b7280",
            fontWeight: 500,
            letterSpacing: "0.6px",
          }}
        >
          {["MARKETPLACES", "RETAIL", "LOGISTICS", "PAYMENTS", "DATA"].map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>

        <div style={{ maxWidth: COLUMN, margin: "0 auto", padding: "30px 20px 60px" }}>
          <div style={{ fontSize: 10.5, color: "#b91c1c", fontWeight: 700, letterSpacing: "1.4px", marginBottom: 10 }}>
            {a.kicker}
          </div>
          <h1 style={{ fontSize: 31, lineHeight: 1.22, fontWeight: 750, color: "#0f172a", margin: "0 0 12px", letterSpacing: "-0.6px" }}>
            {a.headline}
          </h1>
          <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 20, display: "flex", gap: 10 }}>
            <span>{a.desk}</span>
            <span>·</span>
            <span>{a.read}</span>
          </div>
          <div
            style={{
              height: 210,
              borderRadius: 8,
              marginBottom: 10,
              background:
                "linear-gradient(125deg,#0f766e 0%,#0e7490 42%,#334155 100%)," +
                "radial-gradient(60% 80% at 78% 20%, rgba(255,255,255,0.22), transparent 60%)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <svg width="100%" height="100%" viewBox="0 0 640 210" preserveAspectRatio="none" aria-hidden>
              <path d="M0 168 L80 150 L160 158 L240 118 L320 128 L400 78 L480 92 L560 44 L640 58 V210 H0Z" fill="rgba(255,255,255,0.14)" />
              <path
                d="M0 168 L80 150 L160 158 L240 118 L320 128 L400 78 L480 92 L560 44 L640 58"
                stroke="rgba(255,255,255,0.75)"
                strokeWidth="2.5"
                fill="none"
              />
            </svg>
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 26 }}>{a.caption}</div>

          {a.body.map((b, i) => (
            <Body key={i} block={b} selectQuote={selectQuote} />
          ))}
        </div>
      </div>
    </div>
  );
};

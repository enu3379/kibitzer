import React from "react";
import { WINDOW } from "../../theme";

const BODY = [
  "Every marketplace eventually meets the same wall. The first hundred thousand customers arrive on curiosity; the next million have to be bought. What separates the platforms that survive that transition is not how much they spend, but which instrument they reach for.",
  "Coupons remain the fastest lever. A first-order discount converts within hours, which makes it irresistible to teams measured on weekly growth. But discount-acquired cohorts churn at nearly twice the rate of every other channel, and the gap widens after the second purchase.",
  "Membership programmes invert the curve. Conversion is slower and the upfront cost is higher, yet ninety-day retention holds far above the category average — buyers who pay for access behave as though they have already committed.",
  "Curation sits between the two. Editorial feeds and personalised collections cost little per impression, but they only compound once catalogue depth crosses a threshold most platforms reach in year three.",
];

/** Generic trade-press article. No real masthead, no real byline. */
export const NewsMock: React.FC<{ scroll: number }> = ({ scroll }) => (
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

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "30px 20px 60px" }}>
        <div style={{ fontSize: 10.5, color: "#b91c1c", fontWeight: 700, letterSpacing: "1.4px", marginBottom: 10 }}>
          ANALYSIS
        </div>
        <h1 style={{ fontSize: 31, lineHeight: 1.22, fontWeight: 750, color: "#0f172a", margin: "0 0 12px", letterSpacing: "-0.6px" }}>
          How Marketplaces Buy Their First Million Customers
        </h1>
        <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 20, display: "flex", gap: 10 }}>
          <span>Retail Desk</span>
          <span>·</span>
          <span>12 min read</span>
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
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 26 }}>
          Blended acquisition cost across 41 platforms, indexed to 2019.
        </div>

        {BODY.map((p, i) => (
          <p key={i} style={{ fontSize: 15, lineHeight: 1.78, color: "#1f2937", margin: "0 0 19px" }}>
            {p}
          </p>
        ))}

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
          "The cheapest customer you will ever acquire is the one you already have."
        </blockquote>

        {BODY.slice(0, 3).map((p, i) => (
          <p key={`b${i}`} style={{ fontSize: 15, lineHeight: 1.78, color: "#1f2937", margin: "0 0 19px" }}>
            {p}
          </p>
        ))}
      </div>
    </div>
  </div>
);

import React from "react";

/**
 * Generic Korean web portal — the bridge from "just checking something" to the mall.
 * Icon-only brand mark, invented shop names.
 */

const SHORTCUTS = ["메일", "카페", "블로그", "지식iN", "쇼핑", "뉴스", "증권", "부동산", "지도", "웹툰"];

const ADS = [
  { name: "러닝화 신상", price: "89,000", art: "linear-gradient(140deg,#0ea5e9,#4f46e5)", glyph: "👟" },
  { name: "무선 이어버드", price: "119,000", art: "linear-gradient(140deg,#64748b,#1e293b)", glyph: "🎧" },
  { name: "캠핑 체어", price: "54,900", art: "linear-gradient(140deg,#22c55e,#0f766e)", glyph: "🪑" },
  { name: "보온 텀블러", price: "27,500", art: "linear-gradient(140deg,#f59e0b,#dc2626)", glyph: "🥤" },
];

const NEWS = [
  "환율 장중 반등… 수출주 강세",
  "이번 주말 전국 흐리고 비",
  "프로야구 순위 굳히기 돌입",
  "신작 게임 사전 예약 시작",
];

export const PortalMock: React.FC<{ query: string; adHot?: number | null }> = ({ query, adHot = null }) => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", overflow: "hidden" }}>
    {/* brand + search */}
    <div style={{ padding: "26px 0 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, borderBottom: "1px solid #f0f0f0" }}>
      {/* Abstract mark only — evokes a green portal without reproducing any real logo. */}
      <svg width={38} height={38} viewBox="0 0 40 40" aria-hidden>
        <rect x="1" y="1" width="38" height="38" rx="9" fill="#03c75a" />
        <circle cx="17.5" cy="17.5" r="7.5" stroke="#fff" strokeWidth="3.2" fill="none" />
        <path d="M23.4 23.4L29.5 29.5" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" />
      </svg>
      <div
        style={{
          width: 520,
          height: 44,
          border: "2.5px solid #03c75a",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          fontSize: 15,
          color: "#1a1a1a",
        }}
      >
        {query}
        <span style={{ display: "inline-block", width: 1.6, height: 18, background: "#1a1a1a", marginLeft: 2 }} />
        <span style={{ marginLeft: "auto", color: "#03c75a", fontSize: 19 }}>🔍</span>
      </div>
      <div style={{ display: "flex", gap: 22, fontSize: 11.5, color: "#333" }}>
        {SHORTCUTS.map((s) => (
          <span key={s} style={{ fontWeight: s === "쇼핑" ? 700 : 450, color: s === "쇼핑" ? "#03c75a" : "#333" }}>
            {s}
          </span>
        ))}
      </div>
    </div>

    <div style={{ display: "flex", gap: 18, padding: "18px 26px" }}>
      {/* shopping panel — the hook */}
      <div style={{ flex: 1.5, border: "1px solid #e5e7eb", borderRadius: 8, padding: "13px 15px" }}>
        <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a" }}>쇼핑</span>
          <span style={{ fontSize: 10.5, color: "#8e8e8e", marginLeft: 8 }}>지금 뜨는 특가</span>
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "#8e8e8e" }}>더보기 ›</span>
        </div>
        <div style={{ display: "flex", gap: 11 }}>
          {ADS.map((a, i) => (
            <div
              key={a.name}
              style={{
                flex: 1,
                border: `1px solid ${adHot === i ? "#03c75a" : "#f0f0f0"}`,
                borderRadius: 7,
                overflow: "hidden",
                transform: adHot === i ? "translateY(-2px)" : "none",
                boxShadow: adHot === i ? "0 4px 12px rgba(0,0,0,0.12)" : "none",
              }}
            >
              <div style={{ height: 88, background: a.art, display: "grid", placeItems: "center", fontSize: 34 }}>{a.glyph}</div>
              <div style={{ padding: "8px 9px" }}>
                <div style={{ fontSize: 10.5, color: "#333", marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#1a1a1a" }}>
                  {a.price}
                  <span style={{ fontSize: 10, fontWeight: 400 }}>원</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* news column */}
      <div style={{ flex: 1, border: "1px solid #e5e7eb", borderRadius: 8, padding: "13px 15px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a1a", marginBottom: 12 }}>뉴스</div>
        {NEWS.map((n) => (
          <div key={n} style={{ fontSize: 11.5, color: "#333", padding: "7px 0", borderBottom: "1px solid #f5f5f5", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {n}
          </div>
        ))}
      </div>
    </div>
  </div>
);

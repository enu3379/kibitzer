import React from "react";

const SHORTCUTS = [
  { label: "Commerce Weekly", bg: "#1f2937", ch: "C" },
  { label: "MarketPulse", bg: "#0f766e", ch: "M" },
  { label: "Docs", bg: "#2563eb", ch: "D" },
  { label: "Mailbox", bg: "#e8434b", ch: "✉" },
  { label: "Calendar", bg: "#7c3aed", ch: "31" },
];

/** Chrome's new-tab page — the opening shot. */
export const NewTabMock: React.FC = () => (
  <div style={{ position: "absolute", inset: 0, background: "#fff", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 120 }}>
    <div style={{ fontSize: 40, fontWeight: 300, letterSpacing: "-1.5px", color: "#5f6368", marginBottom: 30 }}>
      <span style={{ color: "#4285f4" }}>●</span>
      <span style={{ color: "#ea4335" }}>●</span>
      <span style={{ color: "#fbbc05" }}>●</span>
      <span style={{ color: "#34a853" }}>●</span>
    </div>
    <div
      style={{
        width: 460,
        height: 42,
        borderRadius: 999,
        border: "1px solid #dfe1e5",
        boxShadow: "0 1px 6px rgba(32,33,36,0.10)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 12,
        color: "#9aa0a6",
        fontSize: 13,
      }}
    >
      <svg width={15} height={15} viewBox="0 0 16 16" aria-hidden>
        <circle cx="7" cy="7" r="5" stroke="#9aa0a6" strokeWidth="1.6" fill="none" />
        <path d="M10.8 10.8L14 14" stroke="#9aa0a6" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      웹 검색
    </div>
    <div style={{ display: "flex", gap: 20, marginTop: 44 }}>
      {SHORTCUTS.map((s) => (
        <div key={s.label} style={{ width: 74, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <span style={{ width: 42, height: 42, borderRadius: "50%", background: s.bg, display: "grid", placeItems: "center", color: "#fff", fontWeight: 700, fontSize: 15 }}>
            {s.ch}
          </span>
          <span style={{ fontSize: 10.5, color: "#3c4043", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>
            {s.label}
          </span>
        </div>
      ))}
    </div>
  </div>
);

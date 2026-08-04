import React from "react";

const KPIS = [
  { label: "Blended CAC", value: "$41.20", delta: "+8.4%", up: true },
  { label: "D90 Retention", value: "38.6%", delta: "-2.1%", up: false },
  { label: "Coupon ROI", value: "0.74x", delta: "-11.0%", up: false },
  { label: "Membership LTV", value: "$318", delta: "+16.2%", up: true },
];

const BARS = [
  { k: "Coupon", cac: 0.92, ret: 0.24 },
  { k: "Referral", cac: 0.61, ret: 0.44 },
  { k: "Curation", cac: 0.38, ret: 0.55 },
  { k: "Membership", cac: 0.74, ret: 0.86 },
  { k: "Organic", cac: 0.12, ret: 0.71 },
];

const TABLE = [
  ["Coupon — first order", "$52.80", "21.4%", "0.74x"],
  ["Referral credit", "$34.90", "39.8%", "1.31x"],
  ["Editorial curation", "$21.60", "49.7%", "1.88x"],
  ["Paid membership", "$42.10", "77.2%", "2.44x"],
];

/**
 * Generic analytics dashboard. All figures are invented.
 *
 * `select` (0→1) paints the drag-selection over the two rows that end up pasted into the
 * report — the coupon row and the membership row, the comparison the whole piece hangs on.
 */
const SELECTED_ROWS = [0, 3];

export const StatsMock: React.FC<{ reveal?: number; select?: number }> = ({ reveal = 1, select = 0 }) => (
  <div style={{ position: "absolute", inset: 0, background: "#f7f8fa", overflow: "hidden", color: "#0f172a" }}>
    {/* app bar */}
    <div
      style={{
        height: 42,
        background: "#fff",
        borderBottom: "1px solid #e5e7eb",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 22,
        fontSize: 12,
      }}
    >
      {/* icon only, no wordmark */}
      <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
        <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="#0f766e" />
        <rect x="6" y="12" width="3" height="6" rx="1" fill="#99f6e4" />
        <rect x="10.5" y="8" width="3" height="10" rx="1" fill="#5eead4" />
        <rect x="15" y="10" width="3" height="8" rx="1" fill="#99f6e4" />
      </svg>
      {["Overview", "Acquisition", "Cohorts", "Reports"].map((s, i) => (
        <span key={s} style={{ color: i === 1 ? "#0f172a" : "#6b7280", fontWeight: i === 1 ? 650 : 450 }}>
          {s}
        </span>
      ))}
      <span
        style={{
          marginLeft: "auto",
          fontSize: 11,
          color: "#6b7280",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: "4px 9px",
        }}
      >
        Last 90 days ▾
      </span>
    </div>

    <div style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 12 }}>
        Customer Acquisition — Channel Breakdown
      </div>

      {/* KPI row */}
      <div style={{ display: "flex", gap: 11, marginBottom: 14 }}>
        {KPIS.map((k) => (
          <div
            key={k.label}
            style={{
              flex: 1,
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 9,
              padding: "11px 13px",
            }}
          >
            <div style={{ fontSize: 10.5, color: "#6b7280", fontWeight: 500, marginBottom: 5 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.6px", marginBottom: 3 }}>{k.value}</div>
            <div style={{ fontSize: 10.5, fontWeight: 650, color: k.up ? "#0f766e" : "#b91c1c" }}>
              {k.up ? "▲" : "▼"} {k.delta}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 11 }}>
        {/* grouped bars */}
        <div style={{ flex: 1.35, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "13px 15px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 2 }}>Cost vs. 90-day retention</div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 12 }}>normalised, by channel</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, height: 150, paddingLeft: 4 }}>
            {BARS.map((b, i) => (
              <div key={b.k} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "flex-end", height: 128 }}>
                  <div
                    style={{
                      width: 15,
                      height: 128 * b.cac * Math.min(1, reveal * 1.5 - i * 0.05),
                      background: "#94a3b8",
                      borderRadius: "3px 3px 0 0",
                    }}
                  />
                  <div
                    style={{
                      width: 15,
                      height: 128 * b.ret * Math.min(1, reveal * 1.5 - i * 0.05),
                      background: "#0f766e",
                      borderRadius: "3px 3px 0 0",
                    }}
                  />
                </div>
                <span style={{ fontSize: 9.5, color: "#6b7280" }}>{b.k}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 10, color: "#6b7280" }}>
            <span>
              <i style={{ display: "inline-block", width: 8, height: 8, background: "#94a3b8", borderRadius: 2, marginRight: 5 }} />
              Acquisition cost
            </span>
            <span>
              <i style={{ display: "inline-block", width: 8, height: 8, background: "#0f766e", borderRadius: 2, marginRight: 5 }} />
              D90 retention
            </span>
          </div>
        </div>

        {/* table */}
        <div style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "13px 15px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 12 }}>Channel detail</div>
          <div style={{ display: "flex", fontSize: 9.5, color: "#6b7280", fontWeight: 600, paddingBottom: 7, borderBottom: "1px solid #e5e7eb" }}>
            <span style={{ flex: 2 }}>CHANNEL</span>
            <span style={{ flex: 1, textAlign: "right" }}>CAC</span>
            <span style={{ flex: 1, textAlign: "right" }}>D90</span>
            <span style={{ flex: 1, textAlign: "right" }}>ROI</span>
          </div>
          {TABLE.map((r, i) => {
            const sel = SELECTED_ROWS.includes(i) ? Math.max(0, Math.min(1, select)) : 0;
            return (
              <div
                key={r[0]}
                style={{
                  display: "flex",
                  fontSize: 10.5,
                  padding: "9px 0",
                  borderBottom: "1px solid #f3f4f6",
                  fontVariantNumeric: "tabular-nums",
                  background: `rgba(172,206,247,${sel})`,
                  boxShadow: sel > 0 ? `0 0 0 3px rgba(172,206,247,${sel})` : "none",
                }}
              >
                <span style={{ flex: 2, color: "#0f172a" }}>{r[0]}</span>
                <span style={{ flex: 1, textAlign: "right", color: "#475569" }}>{r[1]}</span>
                <span style={{ flex: 1, textAlign: "right", color: "#475569" }}>{r[2]}</span>
                <span style={{ flex: 1, textAlign: "right", fontWeight: 650 }}>{r[3]}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  </div>
);

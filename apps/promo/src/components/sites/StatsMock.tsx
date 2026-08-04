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
 * `select` (0→1) paints the drag-selection over the rows that end up pasted into the
 * report. The cursor drags from the first row to the last, so all four highlight — a drag
 * cannot skip the middle of a table, and the pasted block has to match what was selected.
 */
const SELECTED_ROWS = [0, 1, 2, 3];

/* ------------------------------------------------------------------ cohorts view */

/** Retention decay per acquisition instrument, sampled at D0/7/14/30/60/90. */
const CURVES = [
  { k: "Membership", c: "#0f766e", v: [1, 0.94, 0.89, 0.84, 0.8, 0.77] },
  { k: "Curation", c: "#0891b2", v: [1, 0.86, 0.74, 0.63, 0.55, 0.5] },
  { k: "Referral", c: "#a16207", v: [1, 0.79, 0.64, 0.51, 0.44, 0.4] },
  { k: "Coupon", c: "#b91c1c", v: [1, 0.61, 0.42, 0.3, 0.24, 0.21] },
];
const X_LABELS = ["D0", "D7", "D14", "D30", "D60", "D90"];
const MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01"];
/** Retention grid — rows are signup months, columns the same checkpoints. */
const GRID = [
  [1, 0.72, 0.58, 0.47, 0.41, 0.38],
  [1, 0.75, 0.61, 0.5, 0.44, 0.41],
  [1, 0.7, 0.55, 0.44, 0.38, 0.34],
  [1, 0.78, 0.66, 0.56, 0.49, 0.46],
];

const CHART = { w: 500, h: 168 };

const CohortsView: React.FC<{ reveal: number }> = ({ reveal }) => {
  const px = (i: number) => 34 + (i / (X_LABELS.length - 1)) * (CHART.w - 52);
  const py = (v: number) => CHART.h - 26 - v * (CHART.h - 46);
  return (
    <>
      <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 12 }}>
        Retention Cohorts — by acquisition instrument
      </div>
      <div style={{ display: "flex", gap: 11 }}>
        <div style={{ flex: 1.35, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "13px 15px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 2 }}>Survival to D90</div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 8 }}>share of first-order cohort still active</div>
          <svg width={CHART.w} height={CHART.h} aria-hidden>
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <g key={g}>
                <line x1={34} x2={CHART.w - 18} y1={py(g)} y2={py(g)} stroke="#eef1f4" strokeWidth="1" />
                <text x={26} y={py(g) + 3.5} fontSize="8.5" fill="#9ca3af" textAnchor="end">
                  {Math.round(g * 100)}
                </text>
              </g>
            ))}
            {X_LABELS.map((l, i) => (
              <text key={l} x={px(i)} y={CHART.h - 8} fontSize="8.5" fill="#9ca3af" textAnchor="middle">
                {l}
              </text>
            ))}
            {CURVES.map((c, ci) => {
              const shown = Math.max(0, Math.min(1, reveal * 1.4 - ci * 0.08));
              const pts = c.v.map((v, i) => `${px(i)},${py(v)}`);
              const keep = Math.max(2, Math.ceil(pts.length * shown));
              return (
                <g key={c.k}>
                  <polyline points={pts.slice(0, keep).join(" ")} fill="none" stroke={c.c} strokeWidth="2" strokeLinejoin="round" />
                  {shown >= 1 ? (
                    <text x={px(5) + 4} y={py(c.v[5]) + 3} fontSize="8.5" fill={c.c} fontWeight="600">
                      {Math.round(c.v[5] * 100)}%
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div style={{ display: "flex", gap: 13, marginTop: 6, fontSize: 10, color: "#6b7280" }}>
            {CURVES.map((c) => (
              <span key={c.k}>
                <i style={{ display: "inline-block", width: 8, height: 8, background: c.c, borderRadius: 2, marginRight: 5 }} />
                {c.k}
              </span>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "13px 15px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 12 }}>By signup month</div>
          <div style={{ display: "flex", fontSize: 9, color: "#6b7280", fontWeight: 600, paddingBottom: 6 }}>
            <span style={{ width: 54 }}>COHORT</span>
            {X_LABELS.map((l) => (
              <span key={l} style={{ flex: 1, textAlign: "center" }}>
                {l}
              </span>
            ))}
          </div>
          {GRID.map((row, r) => (
            <div key={MONTHS[r]} style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 3 }}>
              <span style={{ width: 54, fontSize: 9.5, color: "#475569", fontVariantNumeric: "tabular-nums" }}>{MONTHS[r]}</span>
              {row.map((v, c) => (
                <span
                  key={c}
                  style={{
                    flex: 1,
                    height: 26,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 3,
                    fontSize: 9,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    background: `rgba(15,118,110,${0.09 + v * 0.62 * Math.min(1, reveal * 1.6)})`,
                    color: v > 0.6 ? "#fff" : "#0f172a",
                  }}
                >
                  {Math.round(v * 100)}
                </span>
              ))}
            </div>
          ))}
          <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 9 }}>
            2026-01 cohort holds 46% — the first month membership outsold coupons.
          </div>
        </div>
      </div>
    </>
  );
};

export const StatsMock: React.FC<{ reveal?: number; select?: number; view?: "acquisition" | "cohorts" }> = ({
  reveal = 1,
  select = 0,
  view = "acquisition",
}) => (
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
      {["Overview", "Acquisition", "Cohorts", "Reports"].map((s) => {
        const on = s === (view === "cohorts" ? "Cohorts" : "Acquisition");
        return (
          <span key={s} style={{ color: on ? "#0f172a" : "#6b7280", fontWeight: on ? 650 : 450 }}>
            {s}
          </span>
        );
      })}
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
      {view === "cohorts" ? <CohortsView reveal={reveal} /> : null}
      {view === "cohorts" ? null : (
        <>
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
        </>
      )}
    </div>
  </div>
);

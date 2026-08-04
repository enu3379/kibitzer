import React from "react";

/**
 * Generic analytics dashboard. All figures are invented.
 *
 * This page is the report's primary source, so it carries every number §2 and §3 cite —
 * not just the four rows that get pasted. A dashboard that showed less than the document
 * quotes would make the research look invented rather than the numbers.
 *
 *   scope strip     §2.1 sample, §2.2 FX, §2.3 last-touch attribution
 *   channel table   §3 CAC / D90 / ROI per instrument (this is the block that is pasted)
 *   dispersion      §2.4 median 48,600원 and the 29,000–71,000원 interquartile range
 *   path length     §2.4 "past three steps the cost nearly doubles"
 *   pace panel      §3.2 reorder intervals and payback, §3.3 days to first order
 *   definitions     §2.2 operational definitions, verbatim
 *
 * The won figures in the report are these dollars at the 1,320 rate the scope strip
 * states: $52.80 → 69,700원, $42.10 → 55,600원, $21.60 → 28,500원, median $36.80 →
 * 48,600원, IQR $22.00–$53.80 → 29,000–71,000원.
 */

/** Sample and method, stated on the page so §2 is quoting rather than asserting. */
const SCOPE = ["2025-10 → 2026-03", "12 platforms", "72 monthly cohorts", "1.18M signups", "Attribution: last touch", "KRW 1,320 / $"];

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
 * Cost dispersion across the twelve platforms — the point of §2.4. Values are dollars;
 * the box plot is drawn on a 15–65 scale.
 */
const SPREAD = { min: 18.6, p25: 22.0, median: 36.8, p75: 53.8, max: 61.2 };
const SPREAD_AXIS = { lo: 15, hi: 65 };

/** Steps between landing and first order. The jump past three steps is the finding. */
const PATH = [
  { k: "1–2 steps", cac: "$28.40", share: 0.31, w: 0.40 },
  { k: "3 steps", cac: "$39.10", share: 0.44, w: 0.55 },
  { k: "4+ steps", cac: "$71.30", share: 0.25, w: 1.0 },
];

/** Speed in, speed back. Both halves of §3.2's argument, and §3.3's eleven days. */
const PACE = [
  { k: "Paid membership", first: "8.4d", m1: "31d", m3: "19d", payback: "4.1 mo", good: true },
  { k: "Editorial curation", first: "11.2d", m1: "27d", m3: "22d", payback: "5.6 mo", good: true },
  { k: "Referral credit", first: "3.1d", m1: "30d", m3: "33d", payback: "9.2 mo", good: false },
  { k: "Coupon — first order", first: "0.4d", m1: "34d", m3: "41d", payback: "—", good: false },
];

const DEFINITIONS =
  "Acquisition = signup → first order · Retention = repeat order within 90 days of first order · " +
  "Reinstalls on an existing account are not counted as new · Impression-only traffic excluded (no identifiable signup time)";

/**
 * `select` (0→1) paints the drag-selection over the rows that end up pasted into the
 * report. The cursor drags from the first row to the last, so all four highlight — a drag
 * cannot skip the middle of a table, and the pasted block has to match what was selected.
 *
 * The table's position on the page is therefore load-bearing: CURSOR_PATH drags from
 * (676, 376) to (1092, 488) in screen coordinates. Nothing may be inserted above the
 * charts row without re-tuning those two points.
 */
const SELECTED_ROWS = [0, 1, 2, 3];

const Panel: React.FC<{ title: string; sub?: string; flex?: number; children: React.ReactNode }> = ({
  title,
  sub,
  flex = 1,
  children,
}) => (
  <div style={{ flex, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "11px 14px" }}>
    <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: sub ? 2 : 9 }}>{title}</div>
    {sub ? <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 9 }}>{sub}</div> : null}
    {children}
  </div>
);

/* ------------------------------------------------------------------ cohorts view */

/** Retention decay per acquisition instrument, sampled at D0/7/14/30/60/90. */
const CURVES = [
  { k: "Membership", c: "#0f766e", v: [1, 0.94, 0.89, 0.84, 0.8, 0.77] },
  { k: "Curation", c: "#0891b2", v: [1, 0.86, 0.74, 0.63, 0.55, 0.5] },
  { k: "Referral", c: "#a16207", v: [1, 0.79, 0.64, 0.51, 0.44, 0.4] },
  { k: "Coupon", c: "#b91c1c", v: [1, 0.61, 0.42, 0.3, 0.24, 0.21] },
];
const X_LABELS = ["D0", "D7", "D14", "D30", "D60", "D90"];
/**
 * Six signup months, not four. The last two cannot have a D90 figure yet — which is the
 * third caveat in §2.3, and it is only credible if the page visibly withholds the number.
 */
const MONTHS = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];
const GRID: ReadonlyArray<ReadonlyArray<number | null>> = [
  [1, 0.72, 0.58, 0.47, 0.41, 0.38],
  [1, 0.75, 0.61, 0.5, 0.44, 0.41],
  [1, 0.7, 0.55, 0.44, 0.38, 0.34],
  [1, 0.78, 0.66, 0.56, 0.49, 0.46],
  [1, 0.76, 0.63, 0.53, null, null],
  [1, 0.74, 0.6, null, null, null],
];

/** Discount depth against D90, per platform. r = -0.61 — §3.1's correlation. */
const DISCOUNT = [
  [8, 0.52], [10, 0.47], [12, 0.44], [13, 0.51], [15, 0.36], [17, 0.39],
  [18, 0.31], [20, 0.34], [22, 0.27], [24, 0.3], [27, 0.22], [30, 0.19],
] as const;

/**
 * The twelve platforms on the two axes the report keeps insisting on, grouped by GMV
 * quartile — this is the figure §4 reads and `[표 1]` reproduces. Cost in dollars, D90 as
 * a share. The bands line up with §2.4: the GMV-top platforms are also the cheap ones.
 */
const BANDS = [
  {
    k: "Top quartile",
    c: "#0f766e",
    multiple: "2.1x",
    mix: [58, 27, 15],
    pts: [[22.4, 0.74], [25.9, 0.69], [28.1, 0.71], [30.3, 0.63]],
  },
  {
    k: "Middle",
    c: "#0891b2",
    multiple: "1.4x",
    mix: [31, 38, 31],
    pts: [[33.6, 0.52], [38.2, 0.48], [41.0, 0.44], [45.4, 0.41]],
  },
  {
    k: "Bottom quartile",
    c: "#b91c1c",
    multiple: "0.8x",
    mix: [14, 19, 67],
    pts: [[53.4, 0.31], [55.8, 0.27], [58.2, 0.24], [61.2, 0.19]],
  },
] as const;
const MIX_LABELS = ["Membership", "Curation", "Coupon"] as const;
const MIX_COLORS = ["#0f766e", "#0891b2", "#b91c1c"] as const;

const CHART = { w: 430, h: 168 };
const SCATTER = { w: 196, h: 128 };
const BAND_CHART = { w: 400, h: 150 };

const CohortsView: React.FC<{ reveal: number }> = ({ reveal }) => {
  const px = (i: number) => 34 + (i / (X_LABELS.length - 1)) * (CHART.w - 52);
  const py = (v: number) => CHART.h - 26 - v * (CHART.h - 46);
  const sx = (d: number) => 26 + ((d - 6) / 26) * (SCATTER.w - 38);
  const sy = (r: number) => SCATTER.h - 20 - (r / 0.6) * (SCATTER.h - 34);
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px" }}>Retention Cohorts — by acquisition instrument</div>
        <div style={{ fontSize: 10.5, color: "#6b7280" }}>12 platforms · 72 monthly cohorts · 1.18M signups</div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Panel title="Survival to D90" sub="share of first-order cohort still active" flex={1.25}>
          <svg width={CHART.w} height={CHART.h} aria-hidden>
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <g key={g}>
                <line x1={34} x2={CHART.w - 18} y1={py(g)} y2={py(g)} stroke="#eef1f4" strokeWidth="1" />
                <text x={26} y={py(g) + 3.5} fontSize="8.5" fill="#9ca3af" textAnchor="end">
                  {Math.round(g * 100)}
                </text>
              </g>
            ))}
            {/* D14 is where the instruments have already separated — §3.1 and §3.2 both
                argue from the slope of the first fortnight, not from the endpoint. */}
            <line x1={px(2)} x2={px(2)} y1={py(1)} y2={py(0)} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 3" />
            <text x={px(2) + 4} y={py(1) + 9} fontSize="8" fill="#94a3b8">
              D14 — coupon has lost 58%
            </text>
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
          <div style={{ display: "flex", gap: 13, marginTop: 4, fontSize: 10, color: "#6b7280" }}>
            {CURVES.map((c) => (
              <span key={c.k}>
                <i style={{ display: "inline-block", width: 8, height: 8, background: c.c, borderRadius: 2, marginRight: 5 }} />
                {c.k}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Discount depth vs D90" sub="one point per platform · Pearson r = -0.61">
          <svg width={SCATTER.w} height={SCATTER.h} aria-hidden>
            <line x1={26} x2={SCATTER.w - 10} y1={sy(0)} y2={sy(0)} stroke="#e5e7eb" strokeWidth="1" />
            <line x1={26} x2={26} y1={sy(0.6)} y2={sy(0)} stroke="#e5e7eb" strokeWidth="1" />
            {[0.2, 0.4, 0.6].map((g) => (
              <text key={g} x={22} y={sy(g) + 3} fontSize="8" fill="#9ca3af" textAnchor="end">
                {Math.round(g * 100)}
              </text>
            ))}
            {[10, 20, 30].map((d) => (
              <text key={d} x={sx(d)} y={SCATTER.h - 6} fontSize="8" fill="#9ca3af" textAnchor="middle">
                {d}%
              </text>
            ))}
            <line
              x1={sx(8)}
              y1={sy(0.5)}
              x2={sx(30)}
              y2={sy(0.21)}
              stroke="#b91c1c"
              strokeWidth="1.4"
              strokeDasharray="4 3"
              opacity={Math.min(1, reveal * 1.5)}
            />
            {DISCOUNT.map(([d, r], i) => (
              <circle
                key={i}
                cx={sx(d)}
                cy={sy(r)}
                r={3}
                fill="#0f766e"
                opacity={Math.max(0, Math.min(0.85, reveal * 1.6 - i * 0.03))}
              />
            ))}
          </svg>
          <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 4 }}>
            Quarters with deeper first-order discounts: more first orders, D90 down 3.0%p.
          </div>
        </Panel>

        <Panel title="By signup month" sub="D90 unavailable for cohorts under 90 days old">
          <div style={{ display: "flex", fontSize: 9, color: "#6b7280", fontWeight: 600, paddingBottom: 5 }}>
            <span style={{ width: 50 }}>COHORT</span>
            {X_LABELS.map((l) => (
              <span key={l} style={{ flex: 1, textAlign: "center" }}>
                {l}
              </span>
            ))}
          </div>
          {GRID.map((row, r) => (
            <div key={MONTHS[r]} style={{ display: "flex", alignItems: "center", gap: 2, marginBottom: 2.5 }}>
              <span style={{ width: 50, fontSize: 9, color: "#475569", fontVariantNumeric: "tabular-nums" }}>{MONTHS[r]}</span>
              {row.map((v, c) =>
                v === null ? (
                  <span
                    key={c}
                    style={{
                      flex: 1,
                      height: 21,
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 3,
                      fontSize: 9,
                      color: "#c2c8d0",
                      border: "1px dashed #e5e7eb",
                    }}
                  >
                    –
                  </span>
                ) : (
                  <span
                    key={c}
                    style={{
                      flex: 1,
                      height: 21,
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
                ),
              )}
            </div>
          ))}
          <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 7 }}>
            2026-01 holds 46% — the first month membership outsold coupons. Last two cohorts censored.
          </div>
        </Panel>
      </div>

      {/* second row — the same twelve platforms grouped by size, which is what §4 reads */}
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <Panel title="Cost vs D90, by GMV quartile" sub="one point per platform · dollars against 90-day survival" flex={1.25}>
          <svg width={BAND_CHART.w} height={BAND_CHART.h} aria-hidden>
            {[0.2, 0.4, 0.6, 0.8].map((g) => {
              const y = BAND_CHART.h - 20 - (g / 0.8) * (BAND_CHART.h - 36);
              return (
                <g key={g}>
                  <line x1={30} x2={BAND_CHART.w - 10} y1={y} y2={y} stroke="#eef1f4" strokeWidth="1" />
                  <text x={25} y={y + 3} fontSize="8.5" fill="#9ca3af" textAnchor="end">
                    {Math.round(g * 100)}
                  </text>
                </g>
              );
            })}
            {[20, 30, 40, 50, 60].map((d) => {
              const x = 30 + ((d - 18) / 46) * (BAND_CHART.w - 44);
              return (
                <text key={d} x={x} y={BAND_CHART.h - 6} fontSize="8.5" fill="#9ca3af" textAnchor="middle">
                  ${d}
                </text>
              );
            })}
            {/* 1.0x recovery line — the bottom band never gets above it. */}
            <line
              x1={30}
              y1={BAND_CHART.h - 20 - (0.36 / 0.8) * (BAND_CHART.h - 36)}
              x2={BAND_CHART.w - 10}
              y2={BAND_CHART.h - 20 - (0.36 / 0.8) * (BAND_CHART.h - 36)}
              stroke="#cbd5e1"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text x={BAND_CHART.w - 12} y={BAND_CHART.h - 24 - (0.36 / 0.8) * (BAND_CHART.h - 36)} fontSize="8" fill="#94a3b8" textAnchor="end">
              recovery 1.0x
            </text>
            {BANDS.map((b, bi) =>
              b.pts.map(([cac, d90], i) => (
                <circle
                  key={`${bi}-${i}`}
                  cx={30 + ((cac - 18) / 46) * (BAND_CHART.w - 44)}
                  cy={BAND_CHART.h - 20 - (d90 / 0.8) * (BAND_CHART.h - 36)}
                  r={4}
                  fill={b.c}
                  opacity={Math.max(0, Math.min(0.9, reveal * 1.6 - bi * 0.1 - i * 0.03))}
                />
              )),
            )}
          </svg>
          <div style={{ display: "flex", gap: 14, marginTop: 2, fontSize: 10, color: "#6b7280" }}>
            {BANDS.map((b) => (
              <span key={b.k}>
                <i style={{ display: "inline-block", width: 8, height: 8, background: b.c, borderRadius: 2, marginRight: 5 }} />
                {b.k} · {b.multiple}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Instrument mix by GMV quartile" sub="share of acquired first orders">
          {BANDS.map((b) => (
            <div key={b.k} style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", fontSize: 9.5, color: "#475569", marginBottom: 4 }}>
                <span>{b.k}</span>
                <span style={{ marginLeft: "auto", fontWeight: 650, color: b.c }}>recovery {b.multiple}</span>
              </div>
              <div style={{ display: "flex", height: 15, borderRadius: 3, overflow: "hidden" }}>
                {b.mix.map((share, i) => (
                  <div
                    key={i}
                    style={{
                      width: `${share * Math.min(1, reveal * 1.5)}%`,
                      background: MIX_COLORS[i],
                      opacity: 0.85,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 8.5,
                      color: "#fff",
                      fontWeight: 650,
                    }}
                  >
                    {share >= 18 ? `${share}%` : ""}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{ display: "flex", gap: 12, fontSize: 9.5, color: "#6b7280" }}>
            {MIX_LABELS.map((l, i) => (
              <span key={l}>
                <i style={{ display: "inline-block", width: 8, height: 8, background: MIX_COLORS[i], borderRadius: 2, marginRight: 5 }} />
                {l}
              </span>
            ))}
          </div>
          <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 8, lineHeight: 1.5 }}>
            No band recovers on coupons alone. The bottom quartile leans hardest on them and clears 0.8x.
          </div>
        </Panel>
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ acquisition view */

const AcquisitionView: React.FC<{ reveal: number; select: number }> = ({ reveal, select }) => (
  <>
    <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.3px", marginBottom: 12 }}>
      Customer Acquisition — Channel Breakdown
    </div>

    {/* KPI row */}
    <div style={{ display: "flex", gap: 11, marginBottom: 14 }}>
      {KPIS.map((k) => (
        <div key={k.label} style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "11px 13px" }}>
          <div style={{ fontSize: 10.5, color: "#6b7280", fontWeight: 500, marginBottom: 5 }}>{k.label}</div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.6px", marginBottom: 3 }}>{k.value}</div>
          <div style={{ fontSize: 10.5, fontWeight: 650, color: k.up ? "#0f766e" : "#b91c1c" }}>
            {k.up ? "▲" : "▼"} {k.delta}
          </div>
        </div>
      ))}
    </div>

    {/* NOTHING MAY BE INSERTED ABOVE THIS ROW — the table below is drag-selected at fixed
        screen coordinates in CURSOR_PATH. */}
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

      {/* table — the block that gets pasted into the report */}
      <div style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "13px 15px" }}>
        <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 12 }}>Channel detail</div>
        <div
          style={{
            display: "flex",
            fontSize: 9.5,
            color: "#6b7280",
            fontWeight: 600,
            paddingBottom: 7,
            borderBottom: "1px solid #e5e7eb",
          }}
        >
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

    {/* second row — the panels §2.4 and §3.2 argue from */}
    <div style={{ display: "flex", gap: 11, marginTop: 11 }}>
      <Panel title="Acquisition cost, 12 platforms" sub="median $36.80 · IQR $22.00 – $53.80">
        <div style={{ position: "relative", height: 46, marginTop: 12 }}>
          {(() => {
            const at = (v: number) => ((v - SPREAD_AXIS.lo) / (SPREAD_AXIS.hi - SPREAD_AXIS.lo)) * 100;
            const grow = Math.min(1, reveal * 1.4);
            return (
              <>
                <div style={{ position: "absolute", left: `${at(SPREAD.min)}%`, right: `${100 - at(SPREAD.max)}%`, top: 17, height: 2, background: "#cbd5e1" }} />
                <div
                  style={{
                    position: "absolute",
                    left: `${at(SPREAD.p25)}%`,
                    width: `${(at(SPREAD.p75) - at(SPREAD.p25)) * grow}%`,
                    top: 6,
                    height: 24,
                    background: "rgba(15,118,110,0.18)",
                    border: "1px solid #0f766e",
                    borderRadius: 3,
                  }}
                />
                <div style={{ position: "absolute", left: `${at(SPREAD.median)}%`, top: 3, width: 2, height: 30, background: "#0f766e" }} />
                {[SPREAD_AXIS.lo, 25, 35, 45, 55, SPREAD_AXIS.hi].map((v) => (
                  <span
                    key={v}
                    style={{
                      position: "absolute",
                      left: `${at(v)}%`,
                      top: 34,
                      transform: "translateX(-50%)",
                      fontSize: 8.5,
                      color: "#9ca3af",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    ${v}
                  </span>
                ))}
              </>
            );
          })()}
        </div>
        <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 6 }}>
          Top four platforms acquire under $30; bottom four clear $53. Same category, same quarter, same inventory.
        </div>
      </Panel>

      <Panel title="Steps to first order" sub="landing → first order, all channels pooled">
        {PATH.map((p, i) => (
          <div key={p.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ width: 62, fontSize: 9.5, color: "#475569" }}>{p.k}</span>
            <div style={{ flex: 1, height: 13, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
              <div
                style={{
                  width: `${p.w * 100 * Math.min(1, reveal * 1.5)}%`,
                  height: "100%",
                  background: i === 2 ? "#b91c1c" : "#94a3b8",
                  borderRadius: 3,
                }}
              />
            </div>
            <span style={{ width: 44, textAlign: "right", fontSize: 10, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{p.cac}</span>
            <span style={{ width: 28, textAlign: "right", fontSize: 9, color: "#9ca3af", fontVariantNumeric: "tabular-nums" }}>
              {Math.round(p.share * 100)}%
            </span>
          </div>
        ))}
        <div style={{ fontSize: 9.5, color: "#6b7280", marginTop: 3 }}>Past three steps the cost nearly doubles.</div>
      </Panel>

      <Panel title="Reorder interval & payback" sub="days between orders, month 1 → month 3">
        <div style={{ display: "flex", fontSize: 9, color: "#6b7280", fontWeight: 600, paddingBottom: 5, borderBottom: "1px solid #eef1f4" }}>
          <span style={{ flex: 1.8 }}>INSTRUMENT</span>
          <span style={{ flex: 1, textAlign: "right" }}>1ST ORDER</span>
          <span style={{ flex: 1, textAlign: "right" }}>M1 → M3</span>
          <span style={{ flex: 1, textAlign: "right" }}>PAYBACK</span>
        </div>
        {PACE.map((p) => (
          <div
            key={p.k}
            style={{
              display: "flex",
              fontSize: 9.5,
              padding: "6px 0",
              borderBottom: "1px solid #f6f7f9",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span style={{ flex: 1.8, color: "#0f172a" }}>{p.k}</span>
            <span style={{ flex: 1, textAlign: "right", color: "#475569" }}>{p.first}</span>
            <span style={{ flex: 1, textAlign: "right", color: p.good ? "#0f766e" : "#b91c1c", fontWeight: 650 }}>
              {p.m1} → {p.m3}
            </span>
            <span style={{ flex: 1, textAlign: "right", color: "#475569" }}>{p.payback}</span>
          </div>
        ))}
      </Panel>
    </div>

    <div style={{ fontSize: 9.5, color: "#9ca3af", marginTop: 10, lineHeight: 1.5 }}>{DEFINITIONS}</div>
  </>
);

/* ------------------------------------------------------------------ shell */

export const StatsMock: React.FC<{ reveal?: number; select?: number; view?: "acquisition" | "cohorts" }> = ({
  reveal = 1,
  select = 0,
  view = "acquisition",
}) => (
  <div style={{ position: "absolute", inset: 0, background: "#f7f8fa", overflow: "hidden", color: "#0f172a" }}>
    {/* app bar. The scope strip lives here rather than in its own row, because a row of
        its own would push the channel table off the coordinates the drag is tuned to. */}
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
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
        {SCOPE.map((s, i) => (
          <span
            key={s}
            style={{
              fontSize: 10,
              color: "#6b7280",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              padding: "3px 8px",
              background: i === 0 ? "#f8fafc" : "#fff",
              whiteSpace: "nowrap",
            }}
          >
            {s}
            {i === 0 ? " ▾" : ""}
          </span>
        ))}
      </div>
    </div>

    <div style={{ padding: "16px 18px" }}>
      {view === "cohorts" ? <CohortsView reveal={reveal} /> : <AcquisitionView reveal={reveal} select={select} />}
    </div>
  </div>
);

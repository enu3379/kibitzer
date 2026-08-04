import React from "react";

export type TubeVideo = {
  title: string;
  channel: string;
  views: string;
  /** total length in seconds, for the timestamp readout */
  length: number;
  art: string;
  glyph: string;
  /** Burnt-in subtitle, so the player frame reads as video rather than a poster. */
  caption: string;
};

/** Invented videos — generic snack/convenience-store content, no real creators. */
export const TUBE_VIDEOS: readonly TubeVideo[] = [
  {
    title: "Ranking Every Snack I Could Find",
    channel: "Midnight Pantry",
    views: "2.4M views · 3 days ago",
    length: 1127,
    art: "linear-gradient(135deg,#f97316 0%,#db2777 55%,#4c1d95 100%)",
    glyph: "🍫",
    caption: "…okay, this one is genuinely unbeatable.",
  },
  {
    title: "I Ate Only Convenience Store Food",
    channel: "Midnight Pantry",
    views: "1.1M views · 1 week ago",
    length: 964,
    art: "linear-gradient(135deg,#0ea5e9 0%,#4f46e5 60%,#111827 100%)",
    glyph: "🍜",
    caption: "Day three and I have made a terrible mistake.",
  },
  {
    title: "24 Hours In A Vending Machine Hotel",
    channel: "Slow Detour",
    views: "870K views · 2 weeks ago",
    length: 1508,
    art: "linear-gradient(135deg,#22c55e 0%,#0f766e 55%,#0f172a 100%)",
    glyph: "🏨",
    caption: "Everything in this room came out of a machine.",
  },
  {
    title: "Every Instant Noodle, Ranked Blind",
    channel: "Midnight Pantry",
    views: "3.6M views · 1 month ago",
    length: 1342,
    art: "linear-gradient(135deg,#eab308 0%,#dc2626 58%,#450a0a 100%)",
    glyph: "🍲",
    caption: "I genuinely cannot tell these two apart.",
  },
];

const fmt = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

const UpNext: React.FC<{ activeIndex: number }> = ({ activeIndex }) => (
  <div style={{ width: 250, flexShrink: 0, display: "flex", flexDirection: "column", gap: 9 }}>
    <div style={{ fontSize: 11.5, fontWeight: 650, color: "#f1f1f1", marginBottom: 1 }}>Up next</div>
    {TUBE_VIDEOS.map((v, i) => (
      <div key={v.title} style={{ display: "flex", gap: 8, opacity: i === activeIndex ? 0.42 : 1 }}>
        <div
          style={{
            width: 88,
            height: 50,
            borderRadius: 5,
            background: v.art,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            fontSize: 17,
          }}
        >
          {v.glyph}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              lineHeight: 1.32,
              color: "#f1f1f1",
              fontWeight: 500,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {v.title}
          </div>
          <div style={{ fontSize: 10, color: "#aaa", marginTop: 3 }}>{v.channel}</div>
          <div style={{ fontSize: 10, color: "#aaa" }}>{v.views.split(" · ")[0]}</div>
        </div>
      </div>
    ))}
  </div>
);

/** "MeTube" — a generic video site. Red play badge only; no real wordmark or logo. */
export const TubeMock: React.FC<{ videoIndex: number; progress: number }> = ({ videoIndex, progress }) => {
  const v = TUBE_VIDEOS[videoIndex % TUBE_VIDEOS.length];
  const p = Math.max(0, Math.min(1, progress));
  return (
    <div style={{ position: "absolute", inset: 0, background: "#0f0f0f", color: "#f1f1f1", overflow: "hidden" }}>
      {/* header */}
      <div style={{ height: 44, display: "flex", alignItems: "center", padding: "0 16px", gap: 14, borderBottom: "1px solid #272727" }}>
        {/* Icon only — no wordmark anywhere in the video. */}
        <span
          style={{
            width: 30,
            height: 21,
            borderRadius: 6,
            background: "#e0303a",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 0,
              height: 0,
              marginLeft: 2,
              borderLeft: "8px solid #fff",
              borderTop: "5px solid transparent",
              borderBottom: "5px solid transparent",
            }}
          />
        </span>
        <div
          style={{
            flex: 1,
            maxWidth: 380,
            height: 27,
            border: "1px solid #3f3f3f",
            borderRadius: 999,
            background: "#121212",
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            fontSize: 11,
            color: "#888",
            marginLeft: 20,
          }}
        >
          Search
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ width: 22, height: 22, borderRadius: "50%", background: "linear-gradient(150deg,#8b5cf6,#6366f1)" }} />
      </div>

      <div style={{ display: "flex", gap: 18, padding: "14px 16px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* player */}
          <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 9, overflow: "hidden", background: "#000" }}>
            {/* Fake video frame: art background, out-of-focus foreground shapes, burnt-in caption. */}
            <div style={{ position: "absolute", inset: 0, background: v.art }} />
            <div
              style={{
                position: "absolute",
                left: "-8%",
                bottom: "-26%",
                width: "56%",
                height: "78%",
                borderRadius: "50%",
                background: "rgba(0,0,0,0.28)",
                filter: "blur(26px)",
              }}
            />
            <div
              style={{
                position: "absolute",
                right: "6%",
                top: "-16%",
                width: "38%",
                height: "62%",
                borderRadius: "50%",
                background: "rgba(255,255,255,0.16)",
                filter: "blur(30px)",
              }}
            />
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 46, opacity: 0.94, filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.45))" }}>
              {v.glyph}
            </div>
            <div style={{ position: "absolute", inset: 0, background: "radial-gradient(72% 72% at 50% 42%, transparent 38%, rgba(0,0,0,0.5) 100%)" }} />
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "22%",
                textAlign: "center",
                fontSize: 12,
                fontWeight: 600,
                color: "#fff",
                textShadow: "0 2px 5px rgba(0,0,0,0.85)",
                letterSpacing: "-0.2px",
              }}
            >
              {v.caption}
            </div>

            {/* control bar */}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "22px 12px 8px", background: "linear-gradient(transparent, rgba(0,0,0,0.72))" }}>
              {/* scrubber */}
              <div style={{ position: "relative", height: 3.5, background: "rgba(255,255,255,0.28)", borderRadius: 2, marginBottom: 8 }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, p * 100 + 14)}%`, background: "rgba(255,255,255,0.45)", borderRadius: 2 }} />
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${p * 100}%`, background: "#e0303a", borderRadius: 2 }} />
                <span
                  style={{
                    position: "absolute",
                    left: `${p * 100}%`,
                    top: "50%",
                    width: 11,
                    height: 11,
                    marginLeft: -5.5,
                    marginTop: -5.5,
                    borderRadius: "50%",
                    background: "#e0303a",
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 13, fontSize: 10.5, color: "#fff" }}>
                {/* pause */}
                <span style={{ display: "flex", gap: 3 }}>
                  <i style={{ width: 3.5, height: 12, background: "#fff", borderRadius: 1 }} />
                  <i style={{ width: 3.5, height: 12, background: "#fff", borderRadius: 1 }} />
                </span>
                {/* next */}
                <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden>
                  <path d="M2 2l7 5-7 5z" fill="#fff" />
                  <rect x="10" y="2" width="2" height="10" fill="#fff" />
                </svg>
                {/* volume */}
                <svg width={14} height={13} viewBox="0 0 15 14" aria-hidden>
                  <path d="M2 5h2.6L7.6 2.4v9.2L4.6 9H2z" fill="#fff" />
                  <path d="M9.6 4.8a3.2 3.2 0 0 1 0 4.4M11.4 3a5.8 5.8 0 0 1 0 8" stroke="#fff" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                </svg>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {fmt(v.length * p)} / {fmt(v.length)}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ border: "1px solid rgba(255,255,255,0.6)", borderRadius: 3, padding: "0 3px", fontSize: 8.5, fontWeight: 700 }}>CC</span>
                <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden>
                  <path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" />
                </svg>
              </div>
            </div>
          </div>

          {/* meta */}
          <div style={{ fontSize: 15.5, fontWeight: 700, marginTop: 12, letterSpacing: "-0.3px" }}>{v.title}</div>
          <div style={{ fontSize: 11, color: "#aaa", marginTop: 5 }}>{v.views}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            <span style={{ width: 30, height: 30, borderRadius: "50%", background: "linear-gradient(140deg,#f97316,#be185d)" }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{v.channel}</div>
              <div style={{ fontSize: 10, color: "#aaa" }}>412K subscribers</div>
            </div>
            <span style={{ marginLeft: 8, background: "#f1f1f1", color: "#0f0f0f", borderRadius: 999, padding: "6px 13px", fontSize: 11, fontWeight: 650 }}>
              Subscribe
            </span>
            <span style={{ marginLeft: "auto", background: "#272727", borderRadius: 999, padding: "6px 13px", fontSize: 11, fontWeight: 550 }}>
              ♡ 84K
            </span>
            <span style={{ background: "#272727", borderRadius: 999, padding: "6px 13px", fontSize: 11, fontWeight: 550 }}>Share</span>
          </div>
        </div>

        <UpNext activeIndex={videoIndex % TUBE_VIDEOS.length} />
      </div>
    </div>
  );
};

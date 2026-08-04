import React from "react";

export type SiteKey = "news" | "stats" | "tube" | "mail" | "newtab" | "insta" | "portal" | "shop" | "search";

/**
 * Generic favicons. Deliberately abstract shapes + colours — no real wordmarks or logos
 * anywhere in the video (brand safety).
 */
export const Favicon: React.FC<{ site: SiteKey; size?: number }> = ({ site, size = 15 }) => {
  const box: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: size * 0.26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  switch (site) {
    case "news":
      return (
        <div style={{ ...box, background: "#1f2937" }}>
          <span style={{ color: "#fff", fontSize: size * 0.55, fontWeight: 800, letterSpacing: "-0.5px" }}>C</span>
        </div>
      );
    case "stats":
      return (
        <div style={{ ...box, background: "#0f766e", gap: size * 0.09, alignItems: "flex-end", paddingBottom: size * 0.28 }}>
          <i style={{ width: size * 0.13, height: size * 0.2, background: "#99f6e4" }} />
          <i style={{ width: size * 0.13, height: size * 0.36, background: "#5eead4" }} />
          <i style={{ width: size * 0.13, height: size * 0.28, background: "#99f6e4" }} />
        </div>
      );
    case "insta":
      return (
        <div style={{ ...box, background: "linear-gradient(135deg,#f9ce34,#ee2a7b 55%,#6228d7)", borderRadius: size * 0.3 }}>
          <span
            style={{
              width: size * 0.44,
              height: size * 0.44,
              borderRadius: "50%",
              border: `${Math.max(1, size * 0.11)}px solid #fff`,
              boxSizing: "border-box",
            }}
          />
        </div>
      );
    case "portal":
      return (
        <div style={{ ...box, background: "#03c75a" }}>
          <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="3.6" stroke="#fff" strokeWidth="1.9" fill="none" />
            <path d="M8.9 8.9L12 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      );
    case "shop":
      return (
        <div style={{ ...box, background: "#ff4d4f" }}>
          <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 14 14" aria-hidden>
            <path d="M3 5h8l-.9 5.6H3.9z" fill="#fff" />
            <path d="M5 5a2 2 0 0 1 4 0" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </svg>
        </div>
      );
    case "search":
      return (
        <div style={{ ...box, background: "#fff", border: "1px solid #dfe1e5" }}>
          <svg width={size * 0.68} height={size * 0.68} viewBox="0 0 14 14" aria-hidden>
            <circle cx="5.8" cy="5.8" r="3.9" stroke="#4285f4" strokeWidth="1.8" fill="none" />
            <path d="M8.8 8.8L12.2 12.2" stroke="#34a853" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      );
    case "tube":
      return (
        <div style={{ ...box, background: "#e0303a", borderRadius: size * 0.3 }}>
          <div
            style={{
              width: 0,
              height: 0,
              marginLeft: size * 0.08,
              borderLeft: `${size * 0.3}px solid #fff`,
              borderTop: `${size * 0.19}px solid transparent`,
              borderBottom: `${size * 0.19}px solid transparent`,
            }}
          />
        </div>
      );
    case "mail":
      return (
        <div style={{ ...box, background: "#f4f4f5", border: "1px solid #d4d4d8" }}>
          <svg width={size * 0.66} height={size * 0.5} viewBox="0 0 12 9" aria-hidden>
            <rect x="0.5" y="0.5" width="11" height="8" rx="1.2" fill="#fff" stroke="#9ca3af" strokeWidth="1" />
            <path d="M1 1.6L6 5.1l5-3.5" stroke="#e0303a" strokeWidth="1.2" fill="none" />
          </svg>
        </div>
      );
    default:
      return <div style={{ ...box, background: "#d4d4d8" }} />;
  }
};

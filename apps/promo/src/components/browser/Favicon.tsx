import React from "react";

export type SiteKey = "news" | "stats" | "editor" | "tube" | "mail" | "newtab";

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
    case "editor":
      return (
        <div style={{ ...box, background: "#2563eb", flexDirection: "column", gap: size * 0.1 }}>
          <i style={{ width: size * 0.5, height: size * 0.09, background: "#dbeafe" }} />
          <i style={{ width: size * 0.5, height: size * 0.09, background: "#dbeafe" }} />
          <i style={{ width: size * 0.3, height: size * 0.09, background: "#dbeafe", alignSelf: "flex-start", marginLeft: size * 0.25 }} />
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

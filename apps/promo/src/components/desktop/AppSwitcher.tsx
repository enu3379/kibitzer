import React from "react";
import { FONT, LOGICAL } from "../../theme";

export type AppKey = "browser" | "editor";

const ChromeGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
    <circle cx="32" cy="32" r="30" fill="#fff" />
    <path d="M32 2a30 30 0 0 1 26 15H32a15 15 0 0 0-13.2 7.8z" fill="#ea4335" />
    <path d="M6 17a30 30 0 0 0 18.6 44l13-22.6A15 15 0 0 1 17 32c0-5.6 3-10.5 7.6-13.2z" fill="#34a853" />
    <path d="M58 17a30 30 0 0 1-33.4 44L37.4 38.4A15 15 0 0 0 32 17z" fill="#fbbc05" />
    <circle cx="32" cy="32" r="13" fill="#4285f4" />
    <circle cx="32" cy="32" r="9.5" fill="#fff" />
    <circle cx="32" cy="32" r="7" fill="#4285f4" />
  </svg>
);

const WriterGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#2563eb" />
    <rect x="15" y="14" width="34" height="4" rx="2" fill="#dbeafe" />
    <rect x="15" y="24" width="34" height="4" rx="2" fill="#dbeafe" />
    <rect x="15" y="34" width="34" height="4" rx="2" fill="#dbeafe" />
    <rect x="15" y="44" width="20" height="4" rx="2" fill="#93c5fd" />
  </svg>
);

/**
 * The Cmd-Tab application switcher. Its only job in this video is to make the jump
 * between Chrome and the writing app legible as an app switch rather than a cut.
 */
export const AppSwitcher: React.FC<{ selected: AppKey; opacity: number }> = ({ selected, opacity }) => {
  const apps: Array<{ key: AppKey; label: string; glyph: React.ReactNode }> = [
    { key: "browser", label: "Chrome", glyph: <ChromeGlyph size={86} /> },
    { key: "editor", label: "Writer", glyph: <WriterGlyph size={86} /> },
  ];
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: LOGICAL.height / 2,
        transform: `translate(-50%, -50%) scale(${0.96 + opacity * 0.04})`,
        display: "flex",
        gap: 14,
        padding: 16,
        borderRadius: 22,
        background: "rgba(38,38,44,0.62)",
        backdropFilter: "blur(28px)",
        WebkitBackdropFilter: "blur(28px)",
        boxShadow: "0 18px 50px rgba(0,0,0,0.44)",
        opacity,
        zIndex: 150,
        fontFamily: FONT,
      }}
    >
      {apps.map((a) => (
        <div
          key={a.key}
          style={{
            width: 112,
            height: 112,
            borderRadius: 14,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            background: a.key === selected ? "rgba(255,255,255,0.20)" : "transparent",
          }}
        >
          {a.glyph}
        </div>
      ))}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: -26,
          textAlign: "center",
          fontSize: 13,
          color: "#fff",
          textShadow: "0 1px 4px rgba(0,0,0,0.6)",
        }}
      >
        {apps.find((a) => a.key === selected)?.label}
      </div>
    </div>
  );
};

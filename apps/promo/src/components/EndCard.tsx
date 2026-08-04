import React from "react";
import { AbsoluteFill } from "remotion";
import { FONT, ext } from "../theme";
import { endCard } from "../copy";
import { KibitzerLogo } from "./brand/KibitzerLogo";

export const EndCard: React.FC<{ logoIn: number; textIn: number; subIn: number }> = ({ logoIn, textIn, subIn }) => (
  <AbsoluteFill
    style={{
      background: "radial-gradient(90% 70% at 50% 40%, #1b2436 0%, #0d1220 70%, #080b14 100%)",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: FONT,
      gap: 26,
    }}
  >
    <div style={{ transform: `translateY(${(1 - logoIn) * 22}px) scale(${0.92 + logoIn * 0.08})`, opacity: logoIn }}>
      <KibitzerLogo size={128} />
    </div>
    <div style={{ textAlign: "center", opacity: textIn, transform: `translateY(${(1 - textIn) * 14}px)` }}>
      <div style={{ fontSize: 62, fontWeight: 700, color: "#f4f6fb", letterSpacing: "-2px", lineHeight: 1.05 }}>
        {endCard.wordmark}
      </div>
      <div style={{ fontSize: 25, fontWeight: 500, color: ext.emerald, marginTop: 16, letterSpacing: "-0.5px", wordBreak: "keep-all" }}>
        {endCard.tagline}
      </div>
    </div>
    <div style={{ fontSize: 16, color: "#8b93a7", opacity: subIn, letterSpacing: "-0.2px" }}>{endCard.sub}</div>
  </AbsoluteFill>
);

import React from "react";
import { FONT, LOGICAL } from "../theme";

/**
 * Screencast-style keystroke chip.
 *
 * Copy-paste and tab-completion have no on-screen consequence you can film — the text
 * simply appears. Naming the key is what turns "a block materialised" into "they pasted
 * it", so the chips carry ⌘C / ⌘V / Tab / ⏎ at the moment the gesture happens.
 */
export type KeyHintState = { label: string; opacity: number };

export const KeyHint: React.FC<{ state: KeyHintState }> = ({ state }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 34,
      display: "flex",
      justifyContent: "center",
      opacity: state.opacity,
      pointerEvents: "none",
      fontFamily: FONT,
    }}
  >
    <span
      style={{
        background: "rgba(17,20,24,0.86)",
        color: "#f3f4f6",
        borderRadius: 9,
        padding: "7px 16px",
        fontSize: 17,
        fontWeight: 650,
        letterSpacing: "0.6px",
        boxShadow: "0 6px 22px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.14)",
        transform: `translateY(${(1 - state.opacity) * 8}px)`,
        maxWidth: LOGICAL.width - 80,
      }}
    >
      {state.label}
    </span>
  </div>
);

import React from "react";
import { DotKind, dotColor } from "../../theme";
import { KibitzerLogo } from "../brand/KibitzerLogo";

/**
 * The Kibitzer action icon in the Chrome toolbar.
 *
 * The status dot mirrors STATUS_DOT_COLOR in apps/extension/src/background.ts: it is
 * painted top-right at radius max(2.4, size * 0.16), and "tracking" draws no dot at all
 * — drift only becomes visible once a nudge is actually pending.
 */
export const ExtensionIcon: React.FC<{ dot: DotKind; size?: number; highlight?: boolean }> = ({
  dot,
  size = 19,
  highlight = false,
}) => {
  const color = dotColor[dot];
  const r = Math.max(2.4, size * 0.16);
  return (
    <div
      style={{
        position: "relative",
        width: size + 11,
        height: size + 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        background: highlight ? "rgba(32,33,36,0.10)" : "transparent",
      }}
    >
      <KibitzerLogo size={size} />
      {color ? (
        <span
          style={{
            position: "absolute",
            top: (11 - 1) / 2 - r + 1,
            right: (11 - 1) / 2 - r + 1,
            width: r * 2,
            height: r * 2,
            borderRadius: "50%",
            background: color,
            boxShadow: "0 0 0 1.2px rgba(255,255,255,0.95)",
          }}
        />
      ) : null}
    </div>
  );
};

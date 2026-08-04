import React from "react";
import { DotKind, dotColor } from "../../theme";
import { KibitzerLogo } from "../brand/KibitzerLogo";

/**
 * The Kibitzer action icon in the Chrome toolbar.
 *
 * updateBadge in apps/extension-next/src/lib/badge.ts composites a bare dot onto the icon
 * bitmap (OffscreenCanvas → setIcon) rather than using Chrome's native badge, because the
 * native badge always draws a rounded box behind its text. drawStatusDot puts it at the
 * top-right with r = max(3, size * 0.2) and no outline; the native "●" survives only as a
 * fallback when canvas drawing is unavailable.
 *
 * The dot is present for the whole session and only its colour moves — `none` means no
 * goal is declared, which is the one state that clears it.
 */
export const ExtensionIcon: React.FC<{ dot: DotKind; size?: number; highlight?: boolean }> = ({
  dot,
  size = 19,
  highlight = false,
}) => {
  const color = dotColor[dot];
  const r = Math.max(3, size * 0.2);
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
            // drawStatusDot centres the dot on (size - r, r) inside the icon box, so it
            // sits flush with the icon's top-right corner rather than outside it.
            top: (11 - 1) / 2,
            right: (11 - 1) / 2,
            width: r * 2,
            height: r * 2,
            borderRadius: "50%",
            background: color,
          }}
        />
      ) : null}
    </div>
  );
};

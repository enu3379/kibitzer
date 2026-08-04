import React from "react";
import { BadgeKind, badgeColor } from "../../theme";
import { KibitzerLogo } from "../brand/KibitzerLogo";

/**
 * The Kibitzer action icon in the Chrome toolbar.
 *
 * updateBadge in apps/extension-next/src/lib/badge.ts drives Chrome's *native* badge —
 * `setBadgeText({ text: "●" })` plus a background colour — rather than compositing a dot
 * onto the icon bitmap the way the retired build did. Chrome draws that as a rounded
 * rectangle across the bottom of the icon slot with the glyph centred in it, so this is a
 * plate with a white dot rather than a dot pinned to the icon's corner.
 *
 * The badge is present for the whole session and only its colour moves; `none` means no
 * goal is declared, which is the one state that clears it (`clearBadge`).
 */
export const ExtensionIcon: React.FC<{ badge: BadgeKind; size?: number; highlight?: boolean }> = ({
  badge,
  size = 19,
  highlight = false,
}) => {
  const color = badgeColor[badge];
  // Chrome's badge plate is about half the icon wide and a third of it tall, sitting on
  // the icon's bottom edge and bleeding a little past its right.
  const plateW = Math.round(size * 0.62);
  const plateH = Math.round(size * 0.42);
  const dot = Math.max(2.6, plateH * 0.42);
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
            bottom: (11 - 1) / 2,
            right: (11 - 1) / 2 - 1,
            width: plateW,
            height: plateH,
            borderRadius: 2.5,
            background: color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ width: dot, height: dot, borderRadius: "50%", background: "#fff" }} />
        </span>
      ) : null}
    </div>
  );
};

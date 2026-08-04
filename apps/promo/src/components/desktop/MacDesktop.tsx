import React from "react";
import { AbsoluteFill } from "remotion";
import { CANVAS, FONT, LOGICAL, SCALE, WINDOW } from "../../theme";
import { MenuBar, MenuBarApp } from "./MenuBar";

/**
 * The macOS stage. Everything inside is authored at LOGICAL px and scaled up once here,
 * so child components can use the extension's real CSS numbers unmodified.
 * The Dock is intentionally hidden (confirmed); the menu bar clock carries time passage.
 */
export const MacDesktop: React.FC<{
  clock: string;
  /** Frontmost app — owns the menu bar. */
  app: MenuBarApp;
  /** S5 push-in. Applied below the menu bar so the clock never leaves frame. */
  zoom?: number;
  children: React.ReactNode;
}> = ({ clock, app, zoom = 1, children }) => (
  <AbsoluteFill
    style={{
      background: "#0b0f1a",
      fontFamily: FONT,
      // Subpixel antialiasing produces coloured fringes once frames are downscaled.
      WebkitFontSmoothing: "antialiased",
      textRendering: "geometricPrecision",
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: LOGICAL.width,
        height: LOGICAL.height,
        transform: `scale(${SCALE})`,
        transformOrigin: "top left",
        overflow: "hidden",
      }}
    >
      <Wallpaper />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${zoom})`,
          // Origin sits on the toast horizontally and on the window's top edge vertically,
          // so the push-in tightens toward the nudge without clipping the window header.
          transformOrigin: `${(1000 / LOGICAL.width) * 100}% ${(WINDOW.y / LOGICAL.height) * 100}%`,
        }}
      >
        {children}
      </div>
      <MenuBar clock={clock} app={app} />
    </div>
  </AbsoluteFill>
);

/** Generic aurora wallpaper — evokes macOS without reproducing any Apple artwork. */
const Wallpaper: React.FC = () => (
  <div style={{ position: "absolute", inset: 0, background: "#161a33", overflow: "hidden" }}>
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(120% 92% at 14% 4%, #6a63d8 0%, rgba(106,99,216,0) 60%)," +
          "radial-gradient(105% 78% at 94% 14%, #2f9dc4 0%, rgba(47,157,196,0) 58%)," +
          "radial-gradient(135% 105% at 56% 110%, #bd5b98 0%, rgba(189,91,152,0) 64%)," +
          "radial-gradient(85% 62% at 86% 92%, #e0925e 0%, rgba(224,146,94,0) 56%)," +
          "linear-gradient(168deg, #2f3271 0%, #232653 52%, #1a1d3b 100%)",
      }}
    />
    {/* soft light streaks */}
    <div
      style={{
        position: "absolute",
        left: "-10%",
        top: "12%",
        width: "120%",
        height: 240,
        transform: "rotate(-13deg)",
        background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(160,190,255,0.10) 45%, rgba(255,255,255,0) 100%)",
        filter: "blur(28px)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: "-10%",
        top: "52%",
        width: "120%",
        height: 180,
        transform: "rotate(-9deg)",
        background: "linear-gradient(90deg, rgba(255,255,255,0) 10%, rgba(255,190,220,0.09) 50%, rgba(255,255,255,0) 100%)",
        filter: "blur(34px)",
      }}
    />
    <div style={{ position: "absolute", inset: 0, boxShadow: `inset 0 0 ${CANVAS.height / 4}px rgba(0,0,0,0.42)` }} />
  </div>
);

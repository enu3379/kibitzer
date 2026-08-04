import React from "react";
import { FONT } from "../../theme";

/**
 * A generic macOS application window. Used for the writing app so that it reads as a
 * separate app the user Cmd-Tabs into, not another browser tab.
 */
export const AppWindow: React.FC<{
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  /** Inactive windows lose their traffic-light colour and most of their shadow. */
  active: boolean;
  children: React.ReactNode;
}> = ({ x, y, width, height, title, subtitle, active, children }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width,
      height,
      borderRadius: 11,
      overflow: "hidden",
      background: "#fff",
      fontFamily: FONT,
      boxShadow: active
        ? "0 26px 62px rgba(0,0,0,0.44), 0 3px 12px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(0,0,0,0.30)"
        : "0 10px 26px rgba(0,0,0,0.26), 0 0 0 0.5px rgba(0,0,0,0.24)",
      filter: active ? "none" : "saturate(0.55) brightness(0.97)",
    }}
  >
    <div
      style={{
        height: 38,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        background: active ? "#f6f6f7" : "#efeff0",
        borderBottom: "1px solid #e0e0e2",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", gap: 8 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: active ? c : "#d4d4d6" }} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 12,
          fontWeight: 600,
          color: active ? "#3c3c43" : "#8e8e93",
          pointerEvents: "none",
        }}
      >
        {title}
        {subtitle ? <span style={{ fontWeight: 400, color: "#98989d" }}> — {subtitle}</span> : null}
      </div>
    </div>
    <div style={{ position: "relative", height: height - 38, overflow: "hidden" }}>{children}</div>
  </div>
);

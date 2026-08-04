import React from "react";
import {
  CONTENT_H,
  DotKind,
  FONT,
  TABSTRIP_H,
  TABSTRIP_LEFT,
  TAB_MAX_W,
  TAB_NEW_W,
  TOOLBAR_H,
  WINDOW,
  chrome as C,
} from "../../theme";
import { ExtensionIcon } from "./ExtensionIcon";
import { Favicon, SiteKey } from "./Favicon";

export type TabSpec = {
  id: string;
  site: SiteKey;
  title: string;
  /** 0→1; 1 = full width, 0 = fully collapsed (used when a tab is being closed). */
  width?: number;
};

/** Chrome shrinks tabs to fit the strip; mirror that so 6 tabs still read cleanly. */
export const tabBaseWidth = (count: number): number =>
  Math.min(TAB_MAX_W, (WINDOW.width - TABSTRIP_LEFT - TAB_NEW_W) / Math.max(1, count));

/** Absolute-x of a tab's close button, in logical desktop space. Used by cursor paths. */
export const tabCloseX = (index: number, count: number): number => {
  const w = tabBaseWidth(count);
  return WINDOW.x + TABSTRIP_LEFT + index * w + w - 9 - 5.5;
};

const TrafficLights: React.FC<{ active: boolean }> = ({ active }) => (
  <div style={{ display: "flex", gap: 8, padding: "0 12px 0 14px", alignItems: "center" }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
      <span key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: active ? c : "#c4c6c9" }} />
    ))}
  </div>
);

const Tab: React.FC<{ tab: TabSpec; active: boolean; base: number }> = ({ tab, active, base }) => {
  const w = base * (tab.width ?? 1);
  return (
    <div
      style={{
        width: w,
        minWidth: 0,
        height: TABSTRIP_H - 6,
        marginTop: 6,
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: w > 60 ? "0 9px" : "0 4px",
        borderRadius: "9px 9px 0 0",
        background: active ? C.tabActive : "transparent",
        color: active ? C.tabText : C.tabTextMuted,
        fontSize: 11.5,
        fontWeight: active ? 550 : 450,
        overflow: "hidden",
        flexShrink: 0,
        opacity: w < 24 ? 0 : 1,
      }}
    >
      <Favicon site={tab.site} size={14} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          maskImage: "linear-gradient(90deg, #000 78%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(90deg, #000 78%, transparent 100%)",
        }}
      >
        {tab.title}
      </span>
      <svg width={11} height={11} viewBox="0 0 12 12" style={{ flexShrink: 0, opacity: 0.62 }} aria-hidden>
        <path d="M2.4 2.4l7.2 7.2M9.6 2.4l-7.2 7.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </div>
  );
};

const NavIcons: React.FC = () => (
  <div style={{ display: "flex", alignItems: "center", gap: 3, paddingLeft: 8, color: "#5f6368" }}>
    {[
      "M9.5 3.5L5 8l4.5 4.5", // back
      "M6.5 3.5L11 8l-4.5 4.5", // forward
    ].map((d, i) => (
      <span key={d} style={{ width: 26, height: 26, display: "grid", placeItems: "center", opacity: i === 1 ? 0.38 : 1 }}>
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
          <path d={d} stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    ))}
    <span style={{ width: 26, height: 26, display: "grid", placeItems: "center" }}>
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
        <path
          d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  </div>
);

const PuzzleIcon: React.FC = () => (
  <span style={{ width: 26, height: 26, display: "grid", placeItems: "center", color: "#5f6368" }}>
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M6.2 2.2a1.5 1.5 0 0 1 3 0v.9h1.9c.5 0 .9.4.9.9v1.9h.9a1.5 1.5 0 0 1 0 3h-.9v1.9c0 .5-.4.9-.9.9H9.2v-.9a1.5 1.5 0 0 0-3 0v.9H4.3a.9.9 0 0 1-.9-.9V9.9h-.9a1.5 1.5 0 0 1 0-3h.9V4.9c0-.5.4-.9.9-.9h1.9z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

export const BrowserWindow: React.FC<{
  tabs: readonly TabSpec[];
  activeId: string;
  url: string;
  /** Kibitzer action-icon status dot. */
  dot: DotKind;
  extHighlight?: boolean;
  /** Inactive windows lose their traffic-light colour and most of their shadow. */
  active?: boolean;
  children: React.ReactNode;
}> = ({ tabs, activeId, url, dot, extHighlight, active = true, children }) => (
  <div
    style={{
      position: "absolute",
      left: WINDOW.x,
      top: WINDOW.y,
      width: WINDOW.width,
      height: WINDOW.height,
      borderRadius: 11,
      overflow: "hidden",
      background: C.toolbar,
      boxShadow: active
        ? "0 26px 62px rgba(0,0,0,0.44), 0 3px 12px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(0,0,0,0.30)"
        : "0 10px 26px rgba(0,0,0,0.26), 0 0 0 0.5px rgba(0,0,0,0.24)",
      filter: active ? "none" : "saturate(0.55) brightness(0.97)",
      fontFamily: FONT,
    }}
  >
    {/* tab strip */}
    <div style={{ height: TABSTRIP_H, display: "flex", alignItems: "flex-start", background: C.frame }}>
      <div style={{ display: "flex", alignItems: "center", height: TABSTRIP_H }}>
        <TrafficLights active={active} />
      </div>
      <div style={{ display: "flex", minWidth: 0, flex: 1 }}>
        {tabs.map((t) => (
          <Tab key={t.id} tab={t} active={t.id === activeId} base={tabBaseWidth(tabs.length)} />
        ))}
        <span
          style={{
            width: 26,
            height: 26,
            marginTop: 9,
            marginLeft: 5,
            display: "grid",
            placeItems: "center",
            color: "#5f6368",
            flexShrink: 0,
          }}
        >
          <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
            <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      </div>
    </div>

    {/* toolbar */}
    <div
      style={{
        height: TOOLBAR_H,
        display: "flex",
        alignItems: "center",
        gap: 8,
        paddingRight: 10,
        background: C.toolbar,
        borderBottom: `1px solid ${C.divider}`,
      }}
    >
      <NavIcons />
      <div
        style={{
          flex: 1,
          height: 28,
          borderRadius: 14,
          background: C.omnibox,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 13px",
          fontSize: 11.5,
          color: C.omniboxText,
          minWidth: 0,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 14 14" style={{ flexShrink: 0, opacity: 0.66 }} aria-hidden>
          <rect x="2.6" y="6.2" width="8.8" height="6.2" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
          <path d="M4.8 6.2V4.5a2.2 2.2 0 0 1 4.4 0v1.7" stroke="currentColor" strokeWidth="1.3" fill="none" />
        </svg>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{url}</span>
      </div>
      <PuzzleIcon />
      <ExtensionIcon dot={dot} highlight={extHighlight} />
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "linear-gradient(150deg,#8b5cf6,#6366f1)",
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontSize: 10.5,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        J
      </span>
    </div>

    {/* page viewport — position:relative so the toast can pin to its bottom-right */}
    <div style={{ position: "relative", height: CONTENT_H, overflow: "hidden", background: "#fff" }}>{children}</div>
  </div>
);

import React from "react";
import { FONT, MENUBAR_H } from "../../theme";

/** The frontmost app owns the menu bar — switching apps swaps these, as on macOS. */
export const APP_MENUS = {
  browser: ["Chrome", "파일", "수정", "보기", "방문 기록", "북마크", "프로필", "탭", "창", "도움말"],
  editor: ["Writer", "파일", "편집", "삽입", "서식", "도구", "창", "도움말"],
} as const;

export type MenuBarApp = keyof typeof APP_MENUS;

const AppleMark: React.FC = () => (
  <svg width={13} height={16} viewBox="0 0 14 17" fill="#ffffff" aria-hidden>
    <path d="M11.2 9.02c-.02-2.02 1.65-2.99 1.72-3.04-.94-1.37-2.4-1.56-2.92-1.58-1.24-.13-2.42.73-3.05.73-.63 0-1.6-.71-2.63-.69-1.35.02-2.6.79-3.29 2-1.4 2.43-.36 6.03 1.01 8 .67.96 1.47 2.04 2.51 2 1.01-.04 1.39-.65 2.61-.65 1.22 0 1.56.65 2.63.63 1.09-.02 1.77-.98 2.43-1.95.77-1.12 1.08-2.2 1.1-2.26-.02-.01-2.11-.81-2.13-3.19zM9.22 3.1c.55-.68.93-1.61.83-2.55-.8.03-1.77.53-2.35 1.2-.51.6-.96 1.55-.84 2.46.89.07 1.8-.45 2.36-1.11z" />
  </svg>
);

const StatusIcons: React.FC = () => (
  <svg width={86} height={13} viewBox="0 0 86 13" fill="none" aria-hidden>
    {/* battery */}
    <rect x="0.6" y="2.4" width="21" height="9" rx="2.6" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.1" />
    <rect x="2.1" y="3.9" width="15" height="6" rx="1.4" fill="#ffffff" fillOpacity="0.9" />
    <path d="M23 5.4v3.2c.9-.3 1.3-.8 1.3-1.6S23.9 5.7 23 5.4z" fill="#ffffff" fillOpacity="0.7" />
    {/* wifi */}
    <path d="M35 4.1a8.4 8.4 0 0 1 10.4 0" stroke="#fff" strokeOpacity=".9" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M37.2 6.6a5.2 5.2 0 0 1 6 0" stroke="#fff" strokeOpacity=".9" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="40.2" cy="9.4" r="1.35" fill="#fff" fillOpacity=".9" />
    {/* search */}
    <circle cx="57" cy="6" r="3.8" stroke="#fff" strokeOpacity=".9" strokeWidth="1.3" />
    <path d="M59.9 9.1l2.6 2.6" stroke="#fff" strokeOpacity=".9" strokeWidth="1.3" strokeLinecap="round" />
    {/* control centre */}
    <rect x="72" y="1.8" width="11" height="4.2" rx="2.1" stroke="#fff" strokeOpacity=".9" strokeWidth="1.1" />
    <rect x="72" y="7.6" width="11" height="4.2" rx="2.1" stroke="#fff" strokeOpacity=".9" strokeWidth="1.1" />
    <circle cx="80.4" cy="3.9" r="1.1" fill="#fff" />
    <circle cx="74.6" cy="9.7" r="1.1" fill="#fff" />
  </svg>
);

export const MenuBar: React.FC<{ clock: string; app: MenuBarApp }> = ({ clock, app }) => (
  <div
    style={{
      position: "absolute",
      inset: `0 0 auto 0`,
      height: MENUBAR_H,
      display: "flex",
      alignItems: "center",
      padding: "0 14px",
      gap: 17,
      background: "rgba(20, 22, 34, 0.42)",
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      fontFamily: FONT,
      fontSize: 12.5,
      color: "rgba(255,255,255,0.94)",
      zIndex: 40,
    }}
  >
    <AppleMark />
    {APP_MENUS[app].map((m, i) => (
      <span key={m} style={{ fontWeight: i === 0 ? 700 : 450, letterSpacing: "-0.1px" }}>
        {m}
      </span>
    ))}
    <div style={{ flex: 1 }} />
    <StatusIcons />
    <span style={{ fontWeight: 450, letterSpacing: "-0.1px" }}>8월 4일 (화)</span>
    <span style={{ fontWeight: 450, letterSpacing: "-0.1px", fontVariantNumeric: "tabular-nums" }}>{clock}</span>
  </div>
);

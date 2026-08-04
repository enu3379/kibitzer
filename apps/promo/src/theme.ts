/**
 * Design tokens for the promo video.
 *
 * The whole desktop is authored at LOGICAL pixel sizes (1152x864 = 4:3) using the
 * real CSS values taken from the extension source, then scaled by SCALE to fill the
 * 1440x1080 canvas. That keeps every measurement (320px popup, 300px toast, 13px
 * message text) faithful to the shipping UI while staying legible in video.
 */
export const CANVAS = { width: 1440, height: 1080 } as const;
export const LOGICAL = { width: 1152, height: 864 } as const;
export const SCALE = CANVAS.width / LOGICAL.width; // 1.25
export const FPS = 30;

/** macOS shell */
export const MENUBAR_H = 26;

/** Browser window rect, in logical px */
export const WINDOW = {
  x: 22,
  y: MENUBAR_H + 14,
  width: LOGICAL.width - 44,
  height: LOGICAL.height - (MENUBAR_H + 14) - 22,
} as const;

export const TABSTRIP_H = 38;
export const TOOLBAR_H = 44;
export const CONTENT_H = WINDOW.height - TABSTRIP_H - TOOLBAR_H;

/**
 * Extension icon centre inside the toolbar, relative to the window box.
 * Derived from the toolbar's right-side stack: 10 padding + 22 avatar + 8 gap + 30 icon.
 */
export const EXT_ICON = { x: WINDOW.width - 55, y: TABSTRIP_H + TOOLBAR_H / 2 } as const;

/** Popup is anchored under the toolbar, right edge aligned to the extension icon */
export const POPUP = { width: 320, right: 40, top: TABSTRIP_H + TOOLBAR_H + 6 } as const;

/** Where the tab strip begins (after the traffic lights) and how wide a full tab can be */
export const TABSTRIP_LEFT = 75;
export const TAB_MAX_W = 186;
export const TAB_NEW_W = 31;

/**
 * Toast lives bottom-right of the *page viewport*, like the real content script.
 *
 * TOAST_SCALE magnifies the whole card as one transform rather than re-authoring its
 * numbers: every value inside Toast.tsx stays literally the one in toastOverlay.ts, and
 * the video simply shows it bigger. There is no zoom-in on the nudge in this cut, so the
 * toast has to carry itself at a glance.
 */
export const TOAST = { width: 300, right: 18, bottom: 18 } as const;
export const TOAST_SCALE = 1.5;

/** Extension palette — mirrors apps/extension/src/popup/popup.html (light scheme) */
export const ext = {
  bg: "#ffffff",
  card: "#f4f4f5",
  text: "#18181b",
  muted: "#71717a",
  border: "#e4e4e7",
  accent: "#2563eb",
  emerald: "#10B981",
  sage: "#79B7A0",
  ink: "#1F2937",
  offWhite: "#F9FAFB",
} as const;

/** Badge status dot colours — mirrors STATUS_DOT_COLOR in apps/extension/src/background.ts */
export const dotColor = {
  none: null,
  red: "#a32d2d", // pending — an unanswered nudge
  blue: "#185fa5", // snoozed
  amber: "#ba7517", // no_goal
} as const;
export type DotKind = keyof typeof dotColor;

/** Status pill colours from popup.ts */
export const pill = {
  tracking: { bg: "#dcfce7", fg: "#166534" },
  snoozed: { bg: "#dbeafe", fg: "#1e40af" },
  cooldown: { bg: "#fef3c7", fg: "#92400e" },
  ended: { bg: "#e4e4e7", fg: "#52525b" },
} as const;

/** Chrome browser chrome (macOS light) */
export const chrome = {
  frame: "#dee1e6",
  frameTop: "#d3d6db",
  tabActive: "#ffffff",
  tabText: "#3c4043",
  tabTextMuted: "#5f6368",
  toolbar: "#ffffff",
  omnibox: "#f1f3f4",
  omniboxText: "#202124",
  divider: "#dadce0",
} as const;

export const FONT = "PretendardPromo, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

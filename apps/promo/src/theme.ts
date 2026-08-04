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

/**
 * Popup is anchored under the toolbar, right edge aligned to the extension icon.
 *
 * 296 = the shipping `body { width: 268px; padding: 14px }` measured as Chrome sizes the
 * popup window: nothing in apps/extension-next/src/popup/popup.html sets `box-sizing` on
 * body, so the declared 268 is content only and the padding lands outside it.
 */
export const POPUP = { width: 296, pad: 14, right: 40, top: TABSTRIP_H + TOOLBAR_H + 6 } as const;

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

/**
 * Brand marks shared by the toast and the end card. These four are the only colours the
 * shipping overlay hard-codes outside its light/dark branch — see the `accent`, `ink` and
 * `eye` bindings in apps/extension-next/src/content/toastOverlay.ts.
 */
export const ext = {
  emerald: "#10B981", // intervention border
  sage: "#79B7A0", // celebration border
  ink: "#1F2937", // the head and the hands
  offWhite: "#F9FAFB", // the eyes
} as const;

/**
 * Popup palette — mirrors the <style> block of apps/extension-next/src/popup/popup.html.
 *
 * The shipping popup declares `color-scheme: light dark` and then names exactly two
 * colours of its own: one grey for every secondary line, one green for the start button.
 * Everything else is UA default, which is why `bg`/`text` below are plain white and black
 * rather than the zinc ramp the retired popup carried.
 */
export const popup = {
  bg: "#ffffff",
  text: "#000000",
  muted: "#979797",
  /** `#8884` — the 27%-alpha grey every border in the popup is drawn with. */
  border: "rgba(136,136,136,0.267)",
  start: "#1e7a4c",
  err: "#d1495b",
} as const;

/**
 * Toolbar badge colours — mirrors updateBadge in apps/extension-next/src/lib/badge.ts.
 *
 * Note the inversion from the retired build: this badge is present for the whole session
 * and only its colour moves, so "no badge" now means "no goal declared" rather than
 * "nothing wrong". The bands are S < 33 red, S < 66 amber, else green; a live snooze
 * outranks all three.
 */
export const badgeColor = {
  none: null,
  focused: "#1f9d6b",
  slipping: "#e0a100",
  drifting: "#d1495b",
  snoozed: "#8a8a90",
} as const;
export type BadgeKind = keyof typeof badgeColor;

/** Which band a gauge reading falls in, so scenes can name S and let the badge follow. */
export const badgeForGauge = (s: number, snoozed = false): BadgeKind =>
  snoozed ? "snoozed" : s < 33 ? "drifting" : s < 66 ? "slipping" : "focused";

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

/**
 * KNOWN DEVIATION. The shipping UI asks for `system-ui` first and therefore renders in
 * Apple SD Gothic Neo on macOS and Malgun Gothic on Windows; this bundles Pretendard
 * ahead of both. That is deliberate — `remotion render` runs in a headless Chrome with no
 * Korean system face, so a faithful stack would fall back mid-render and the output would
 * not match the Studio preview (see fonts.ts). Korean stroke weight is a little lighter
 * here than in the real popup; everything else about the type is the shipping value.
 */
export const FONT = "PretendardPromo, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

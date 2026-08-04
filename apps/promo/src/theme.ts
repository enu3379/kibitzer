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
 * The `--sd-*` group is the popup's own "sundial" palette: monochrome ink with a single
 * leaf green, and the only colour in the sundial drawing is on the leaves. `color-scheme:
 * light dark` supplies the page background and body text, which is why `bg`/`text` are
 * plain white and black rather than a named ramp.
 */
export const popup = {
  bg: "#ffffff",
  text: "#000000",
  /** --sd-ink / --sd-ink3 / --sd-line, consumed by the sundial SVG as CSS variables. */
  sdInk: "#6e6960",
  sdInk3: "#9b968c",
  sdLine: "#e6e3dc",
  sdLeaf: "#5aa63c",
  /** The popup's greys, which are per-rule literals rather than variables. */
  h1: "#888888",
  label: "#999999",
  muted: "#888888",
  /** `#8884` / `#8883` — the alpha greys every border in the popup is drawn with. */
  border: "rgba(136,136,136,0.267)",
  border3: "rgba(136,136,136,0.2)",
  start: "#1e7a4c",
  judgeOn: "#1f9d6b",
  err: "#d1495b",
} as const;

/**
 * Immersion-band colours — the `--m` custom property on `.agauge` / `.meter`.
 *
 * bandOf in lib/sessionStats.ts: ≥66 집중, 33–65 흔들림, <33 이탈. A live pause overrides
 * the band outright. The track is the same hue at 18% via color-mix.
 */
export const band = {
  ok: { m: "#2b9e57", word: "집중" },
  warn: { m: "#ad7d15", word: "흔들림" },
  bad: { m: "#c94f4f", word: "이탈" },
  paused: { m: "#8e8b84", word: "일시정지" },
} as const;
export type BandKind = keyof typeof band;

export const bandOf = (s: number, paused = false): BandKind =>
  paused ? "paused" : s >= 66 ? "ok" : s >= 33 ? "warn" : "bad";

/** color-mix(in srgb, <m> 18%, transparent) — the meter track, resolved for the render. */
export const trackOf = (m: string): string => `${m}2e`;

/**
 * Toolbar status dot — mirrors drawStatusDot in apps/extension-next/src/lib/badge.ts.
 *
 * This is composited onto the action icon (OffscreenCanvas → setIcon), NOT Chrome's
 * native badge: the native badge always draws a rounded box behind its text, so a bare
 * dot has to be painted into the bitmap. Top-right corner, r = max(3, size * 0.2), no
 * outline. The dot is present for the whole session and only its colour moves, so "none"
 * means no goal declared (clearBadge) rather than "nothing wrong".
 */
export const dotColor = {
  none: null,
  focused: "#1f9d6b",
  slipping: "#e0a100",
  drifting: "#d1495b",
  snoozed: "#8a8a90",
} as const;
export type DotKind = keyof typeof dotColor;

/** Which dot a gauge reading earns, so scenes can name S and let the icon follow. */
export const dotForGauge = (s: number, snoozed = false): DotKind =>
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

/** The set — browser chrome, mock websites, the writing app. Not the product. */
export const FONT = "PretendardPromo, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

/**
 * The product. The extension bundles Gowun Dodum and declares it ahead of every system
 * face, so this stack is the shipping one with the bundled family renamed — see the
 * `@font-face` and `body` rules in apps/extension-next/src/popup/popup.html.
 */
export const POPUP_FONT =
  "GowunDodumPromo, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', system-ui, sans-serif";

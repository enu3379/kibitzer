import { Easing } from "remotion";
import { DotKind, WINDOW } from "../theme";
import { GOAL, GOAL_BUDGET_MIN, dashboard, nudge, praise, report, tabs as tabTitles } from "../copy";
import { SWITCHER_FRAMES, beat, clockAt, scene } from "../timeline";
import { between, progress, range, toastEase } from "../lib/anim";
import { typed, typedLines } from "../lib/typewriter";
import { Waypoint } from "../lib/cursor";
import { TabSpec, tabCloseX } from "../components/browser/BrowserWindow";
import { PopupState } from "../components/extension/ExtensionPopup";
import { HotButton } from "../components/toast/Toast";
import { AppKey } from "../components/desktop/AppSwitcher";

/* ------------------------------------------------------------------ types */

export type PageKind =
  | { k: "newtab" }
  | { k: "news"; scroll: number }
  | { k: "stats"; reveal: number }
  | { k: "tube"; video: number; progress: number }
  | { k: "igFeed"; scroll: number }
  | { k: "igDm"; thread: number; messages: number; typing: boolean; badge: number }
  | { k: "portal"; query: string; adHot: number | null }
  | { k: "shop"; view: "detail" | "cart"; product: number; cart: number; cartPulse: number; addHot: boolean }
  | { k: "mail"; reveal: number; sendHot: boolean; sent: boolean };

export type EditorState = {
  lines: string[];
  caret: boolean;
  body?: readonly string[];
  scroll: number;
  complete: boolean;
};

export type ToastState = {
  celebration: boolean;
  message: string;
  context?: string;
  reveal: number;
  lift: number;
  peek: number;
  hotButton: HotButton;
  closeHot: boolean;
};

export type Stage = {
  clock: string;
  /** Frontmost application. Decides window stacking and who owns the menu bar. */
  focus: AppKey;
  /** Present from S2 onward — the writing app stays open behind the browser. */
  editor: EditorState | null;
  switcher: { selected: AppKey; opacity: number } | null;
  tabs: TabSpec[];
  activeId: string;
  url: string;
  dot: DotKind;
  page: PageKind;
  popup: { state: PopupState; reveal: number } | null;
  toast: ToastState | null;
  zoom: number;
};

/* ------------------------------------------------------------------ fixtures */

/** The music tab is opened before the session and deliberately survives the S5 cleanup. */
const TAB = {
  newtab: { id: "newtab", site: "newtab", title: "새 탭" },
  music: { id: "music", site: "tube", title: tabTitles.music },
  news: { id: "news", site: "news", title: tabTitles.news },
  stats: { id: "stats", site: "stats", title: tabTitles.stats },
  insta: { id: "insta", site: "insta", title: tabTitles.insta },
  portal: { id: "portal", site: "portal", title: tabTitles.portal },
  shop: { id: "shop", site: "shop", title: tabTitles.shop },
  mail: { id: "mail", site: "mail", title: tabTitles.mail },
} as const satisfies Record<string, TabSpec>;

const URL = {
  newtab: "새 탭",
  music: "metube.com/watch?v=8kR2vQ",
  news: "commerceweekly.com/analysis/how-marketplaces-buy-their-first-million-customers",
  stats: "app.marketpulse.io/acquisition/channels",
  igFeed: "gramline.com/",
  igDm: "gramline.com/direct/inbox",
  portal: "narae.com/search?query=러닝화+추천",
  shopCart: "shop.daylight.co.kr/cart",
  mail: "mail.workspace.com/u/0/#compose",
} as const;

/** Keeps the address bar honest as the montage steps through products. */
const PRODUCT_SLUGS = [
  "stride-air-3",
  "audio-n-buds-anc",
  "outline-camp-chair",
  "dayloop-tumbler-500",
  "plainwear-cotton-hoodie",
  "typebox-fold-keyboard",
  "morning-co-dripbag-30",
] as const;

/** Toast entrance: 10 frames ≈ the 0.34s transition in toastOverlay.ts. */
const TOAST_IN = 10;
const toastEnter = (frame: number, at: number) => ({
  reveal: range(frame, [at, at + TOAST_IN], [0, 1], toastEase),
  lift: range(frame, [at, at + TOAST_IN], [26, 0], toastEase),
  peek: range(frame, [at + 2, at + 2 + TOAST_IN], [0, 1], toastEase),
});
const toastExit = (frame: number, at: number, len = 8) => ({
  reveal: range(frame, [at, at + len], [1, 0], Easing.in(Easing.quad)),
  lift: range(frame, [at, at + len], [0, 20], Easing.in(Easing.quad)),
});

/**
 * Cmd-Tab. The switcher fades up, the focus flips at its midpoint, then it fades out —
 * so the app change lands *while* the overlay is on screen, like the real gesture.
 */
const SWITCH_AT = (start: number) => start + Math.round(SWITCHER_FRAMES / 2);
const applySwitch = (frame: number, st: Stage, start: number, to: AppKey): void => {
  const end = start + SWITCHER_FRAMES;
  if (frame >= SWITCH_AT(start)) st.focus = to;
  if (frame >= start && frame < end + 4) {
    st.switcher = {
      selected: frame >= SWITCH_AT(start) ? to : to === "editor" ? "browser" : "editor",
      opacity: Math.min(range(frame, [start, start + 3], [0, 1]), range(frame, [end, end + 4], [1, 0])),
    };
  }
};

const editorDoc = (lines: string[], caret: boolean, extra: Partial<EditorState> = {}): EditorState => ({
  lines,
  caret,
  scroll: 0,
  complete: false,
  ...extra,
});

/* ------------------------------------------------------------------ S1 — goal declaration */

const s1 = (frame: number, st: Stage): void => {
  st.tabs = [{ ...TAB.newtab }];
  st.activeId = "newtab";
  st.url = URL.newtab;
  st.page = { k: "newtab" };
  // No goal declared yet -> the amber "no_goal" dot, per STATUS_DOT_COLOR in background.ts.
  st.dot = frame < beat.startClick ? "amber" : "none";

  const reveal =
    frame < beat.popupOpen
      ? 0
      : Math.min(
          progress(frame, beat.popupOpen, 8),
          range(frame, [beat.popupClose, beat.popupClose + 6], [1, 0], Easing.in(Easing.quad)),
        );
  if (reveal <= 0) return;

  st.popup = {
    reveal,
    state:
      frame < beat.startClick + 2
        ? {
            kind: "setup",
            goal: typed(GOAL, frame, beat.goalTypeStart),
            budget: frame >= beat.goalTypeEnd + 4 ? GOAL_BUDGET_MIN : "",
            typingGoal: between(frame, beat.goalTypeStart - 4, beat.startClick),
            startPressed: between(frame, beat.startClick, beat.startClick + 5),
          }
        : {
            kind: "dashboard",
            goal: GOAL,
            pillLabel: "추적 중",
            pillTone: "green",
            pageTitle: "새 탭",
            pageHost: "—",
            pageDrift: false,
            streak: 0,
            observations: "–",
            relatedRatio: "–",
          },
  };
};

/* ------------------------------------------------------------------ S2 — focused work */

const s2 = (frame: number, st: Stage): void => {
  st.tabs = [{ ...TAB.music }, { ...TAB.news }, { ...TAB.stats }];
  st.dot = "none";

  if (frame < beat.newsEnter) {
    // Music on before the work starts. This tab is background audio, not drift —
    // it is never nudged about and never closed.
    st.activeId = "music";
    st.url = URL.music;
    st.page = { k: "tube", video: 0, progress: range(frame, [beat.musicView, beat.newsEnter], [0.12, 0.3], Easing.linear) };
  } else if (frame < beat.statsEnter) {
    st.activeId = "news";
    st.url = URL.news;
    st.page = { k: "news", scroll: range(frame, [beat.newsEnter + 6, beat.statsEnter - 4], [0, 470]) };
  } else {
    st.activeId = "stats";
    st.url = URL.stats;
    st.page = { k: "stats", reveal: progress(frame, beat.statsEnter, 22) };
  }

  // The writing app opens and takes focus — a separate application, not a tab.
  if (frame >= beat.switchToEditor1 + 4) {
    st.editor = editorDoc(typedLines(report.outline, frame, beat.outlineTypeStart, 1), frame >= beat.outlineTypeStart);
  }
  applySwitch(frame, st, beat.switchToEditor1, "editor");
};

/* ------------------------------------------------------------------ S3 — drift #1: direct messages */

/** Messages pile up steadily; the unread badge climbs with them. */
const dmState = (frame: number, from: number) => ({
  thread: Math.min(3, Math.floor((frame - from) / 34)),
  messages: Math.min(8, 3 + Math.floor((frame - from) / 11)),
  typing: Math.floor((frame - from) / 11) % 3 === 2,
  badge: Math.min(9, 3 + Math.floor((frame - from) / 26)),
});

const s3 = (frame: number, st: Stage): void => {
  st.editor = editorDoc([...report.outline], false);
  st.focus = "editor";
  applySwitch(frame, st, beat.switchToBrowser1, "browser");

  st.tabs = [{ ...TAB.music }, { ...TAB.news }, { ...TAB.stats }];
  st.activeId = "stats";
  st.url = URL.stats;
  st.page = { k: "stats", reveal: 1 };
  st.dot = "none";

  if (frame < beat.igEnter) return;

  st.tabs.push({ ...TAB.insta });
  st.activeId = "insta";

  if (frame < beat.igDmEnter) {
    st.url = URL.igFeed;
    st.page = { k: "igFeed", scroll: range(frame, [beat.igEnter + 4, beat.igDmEnter], [0, 210], Easing.linear) };
  } else {
    st.url = URL.igDm;
    st.page = { k: "igDm", ...dmState(frame, beat.igDmEnter) };
  }

  // The dot only turns red once a nudge is actually pending — matches background.ts.
  st.dot = frame >= beat.dotRed1 ? "red" : "none";

  if (frame >= beat.nudge1In) {
    const enter = toastEnter(frame, beat.nudge1In);
    const exit = toastExit(frame, beat.nudge1Dismiss);
    const reveal = Math.min(enter.reveal, exit.reveal);
    if (reveal > 0) {
      st.toast = {
        celebration: false,
        message: nudge.first.message,
        context: nudge.first.context,
        reveal,
        lift: Math.max(enter.lift, exit.lift),
        peek: enter.peek,
        hotButton: null,
        closeHot: between(frame, beat.nudge1Dismiss - 6, beat.nudge1Dismiss + 2),
      };
    }
  }
};

/* ------------------------------------------------------------------ S4 — snooze + time-lapse */

const s4 = (frame: number, st: Stage): void => {
  st.editor = editorDoc([...report.outline], false);
  st.tabs = [{ ...TAB.music }, { ...TAB.news }, { ...TAB.stats }, { ...TAB.insta }];
  st.activeId = "insta";
  st.url = URL.igDm;
  st.dot = frame < beat.snoozeClick ? "red" : frame < beat.nudge3In ? "blue" : "red";

  if (between(frame, beat.nudge2In, beat.montageStart)) {
    const enter = toastEnter(frame, beat.nudge2In);
    const exit = toastExit(frame, beat.snoozeClick);
    const reveal = Math.min(enter.reveal, exit.reveal);
    if (reveal > 0) {
      st.toast = {
        celebration: false,
        message: nudge.second.message,
        context: nudge.second.context,
        reveal,
        lift: Math.max(enter.lift, exit.lift),
        peek: enter.peek,
        hotButton: between(frame, beat.snoozeClick - 8, beat.snoozeClick + 3) ? "break" : null,
        closeHot: false,
      };
    }
  }

  if (frame < beat.montageStart) {
    st.page = { k: "igDm", ...dmState(frame, beat.igDmEnter) };
    return;
  }

  /*
   * Time-lapse: a search on the portal turns into a shopping spree. The cart badge is
   * the clock — 0 → 7 across the montage says "time passed" far more concretely than
   * scrolling ever could, and it is the payoff of the report's own subject matter.
   */
  if (frame < beat.shopEnter) {
    st.tabs.push({ ...TAB.portal });
    st.activeId = "portal";
    st.url = URL.portal;
    st.page = {
      k: "portal",
      query: typed("러닝화 추천", frame, beat.portalEnter + 2, 2),
      adHot: between(frame, beat.shopEnter - 16, beat.shopEnter) ? 0 : null,
    };
  } else {
    st.tabs.push({ ...TAB.portal }, { ...TAB.shop });
    st.activeId = "shop";

    const cartView = frame >= beat.cartViewEnter;
    // Mild ease-in: the spree accelerates, but gently enough that the badge is seen
    // climbing rather than jumping from 1 to 7 in the last few frames.
    const mp = range(frame, [beat.shopEnter, beat.cartViewEnter], [0, 7], Easing.in(Easing.poly(1.4)));
    const added = Math.min(7, Math.floor(mp));
    const local = mp - added;

    st.url = cartView ? URL.shopCart : `shop.daylight.co.kr/products/${PRODUCT_SLUGS[Math.min(6, added)]}`;
    st.page = {
      k: "shop",
      view: cartView ? "cart" : "detail",
      product: Math.min(6, added),
      cart: cartView ? 7 : added,
      // Pop the badge for a few frames right after each item lands.
      cartPulse: cartView ? 0 : Math.max(0, 1 - local * 6),
      addHot: !cartView && local > 0.72,
    };
  }

  // Nudge #3 — the snooze callback. (Promotional assumption: the shipping build resumes
  // silently after a snooze expires. Flagged in storyboard.md.)
  if (frame >= beat.nudge3In) {
    st.toast = {
      celebration: false,
      message: nudge.third.message,
      context: nudge.third.context,
      ...toastEnter(frame, beat.nudge3In),
      hotButton: null,
      closeHot: false,
    };
  }
};

/* ------------------------------------------------------------------ S5 — the awakening */

const collapse = (frame: number, at: number): number => range(frame, [at, at + 8], [1, 0], Easing.in(Easing.cubic));

const s5 = (frame: number, st: Stage): void => {
  st.editor = editorDoc([...report.outline], false);
  // The music tab stays — it was never the problem, and leaving it makes the point that
  // Kibitzer nudges on drift, not on "anything that isn't work".
  st.tabs = [
    { ...TAB.music },
    { ...TAB.news },
    { ...TAB.stats },
    { ...TAB.insta, width: collapse(frame, beat.closeTab1) },
    { ...TAB.portal, width: collapse(frame, beat.closeTab2) },
    { ...TAB.shop, width: collapse(frame, beat.closeTab3) },
  ];

  // Freeze: everything holds and the frame pushes in 5%. The menu bar stays put.
  st.zoom = Math.min(
    range(frame, [beat.freezeStart, beat.freezeStart + 22], [1, 1.04]),
    range(frame, [beat.freezeEnd + 8, beat.freezeEnd + 28], [1.04, 1]),
  );

  const returned = frame >= beat.closeTab3 + 8;
  st.activeId = returned ? "stats" : "shop";
  st.url = returned ? URL.stats : URL.shopCart;
  st.dot = frame >= beat.returnToGoalTab ? "none" : "red";
  st.page = returned
    ? { k: "stats", reveal: 1 }
    : { k: "shop", view: "cart", product: 0, cart: 7, cartPulse: 0, addHot: false };

  // Nudge #3 stays up through the freeze — it is what triggers the realisation.
  const enter = toastEnter(frame, beat.nudge3In);
  const exit = toastExit(frame, beat.freezeEnd + 8);
  const reveal = Math.min(enter.reveal, exit.reveal);
  if (reveal > 0) {
    st.toast = {
      celebration: false,
      message: nudge.third.message,
      context: nudge.third.context,
      reveal,
      lift: Math.max(enter.lift, exit.lift),
      peek: enter.peek,
      hotButton: null,
      closeHot: false,
    };
  }
};

/* ------------------------------------------------------------------ S6 — praise + resume */

const s6 = (frame: number, st: Stage): void => {
  st.tabs = [{ ...TAB.music }, { ...TAB.news }, { ...TAB.stats }];
  st.activeId = "stats";
  st.url = URL.stats;
  st.dot = "none";
  st.page = { k: "stats", reveal: 1 };

  // The celebration lands in the browser, on a goal-related page — the extension can
  // only draw inside a tab, so praising here (not in the writing app) stays truthful.
  const enter = toastEnter(frame, beat.praiseIn);
  const exit = toastExit(frame, beat.praiseOut, 10);
  const reveal = Math.min(enter.reveal, exit.reveal);
  if (reveal > 0) {
    st.toast = {
      celebration: true,
      message: praise.message,
      reveal,
      lift: Math.max(enter.lift, exit.lift),
      peek: enter.peek,
      hotButton: null,
      closeHot: false,
    };
  }

  st.editor = editorDoc(
    [...report.outline, ...typedLines([report.resumed], frame, beat.resumeTypeStart, 1)],
    frame >= beat.resumeTypeStart,
  );
  applySwitch(frame, st, beat.switchToEditor2, "editor");
  if (frame >= SWITCH_AT(beat.switchToEditor2)) st.focus = "editor";
};

/* ------------------------------------------------------------------ S7 — wrap-up */

const s7 = (frame: number, st: Stage): void => {
  st.focus = "editor";
  st.editor = editorDoc([...report.outline, report.resumed], false, {
    body: report.body,
    complete: true,
    scroll: range(frame, [scene.s7WrapUp.from, beat.switchToBrowser2], [0, 96]),
  });
  st.tabs = [{ ...TAB.music }, { ...TAB.news }, { ...TAB.stats }];
  st.activeId = "stats";
  st.url = URL.stats;
  st.dot = "none";
  st.page = { k: "stats", reveal: 1 };

  applySwitch(frame, st, beat.switchToBrowser2, "browser");
  if (frame < SWITCH_AT(beat.switchToBrowser2)) return;

  st.tabs.push({ ...TAB.mail });
  st.activeId = "mail";
  st.url = URL.mail;
  st.page = {
    k: "mail",
    reveal: progress(frame, beat.mailOpen, 12),
    sendHot: between(frame, beat.sendClick - 6, beat.sendClick + 3),
    sent: frame >= beat.mailSent,
  };

  if (frame >= beat.popupOpen2) {
    st.popup = {
      reveal: progress(frame, beat.popupOpen2, 8),
      state:
        frame >= beat.summaryShown
          ? { kind: "summary" }
          : {
              kind: "dashboard",
              goal: GOAL,
              pillLabel: "추적 중",
              pillTone: "green",
              pageTitle: dashboard.pageTitle,
              pageHost: dashboard.pageHost,
              pageDrift: false,
              streak: 0,
              observations: dashboard.observations,
              relatedRatio: dashboard.relatedRatio,
              endPressed: between(frame, beat.endSessionClick - 4, beat.endSessionClick + 2),
            },
    };
  }
};

/* ------------------------------------------------------------------ compose */

export const stageAt = (frame: number): Stage => {
  const st: Stage = {
    clock: clockAt(frame),
    focus: "browser",
    editor: null,
    switcher: null,
    tabs: [],
    activeId: "",
    url: "",
    dot: "none",
    page: { k: "newtab" },
    popup: null,
    toast: null,
    zoom: 1,
  };

  if (frame < scene.s2Focus.from) s1(frame, st);
  else if (frame < scene.s3Drift.from) s2(frame, st);
  else if (frame < scene.s4Escalate.from) s3(frame, st);
  else if (frame < scene.s5Return.from) s4(frame, st);
  else if (frame < scene.s6Praise.from) s5(frame, st);
  else if (frame < scene.s7WrapUp.from) s6(frame, st);
  else s7(frame, st);

  return st;
};

/* ------------------------------------------------------------------ cursor path */

const EXT = { x: WINDOW.x + WINDOW.width - 55, y: WINDOW.y + 60 };
const TAB_Y = WINDOW.y + 22;
/** Centre-ish of tab `i`, for clicking the tab itself rather than its ✕. */
const tabX = (i: number, count: number) => tabCloseX(i, count) - 78;

/**
 * Hit points inside the popup, toast and mail sheet. Tuned against the rendered stills
 * rather than computed, because all three boxes are auto-height.
 */
const HIT = {
  goalInput: { x: 928, y: 208 },
  startBtn: { x: 928, y: 330 },
  endSessionBtn: { x: 1003, y: 606 },
  toastClose: { x: 1088, y: 706 },
  toastBreak: { x: 968, y: 796 },
  mailSend: { x: 706, y: 817 },
  /** "+" new-tab button, with three tabs open. */
  newTab: { x: 673, y: WINDOW.y + 22 },
  /** Direct-message icon in the social app's header. */
  igDmIcon: { x: 1065, y: 144 },
  /** First product card in the portal's shopping panel — the bridge to the mall. */
  portalAd: { x: 133, y: 419 },
  /** "장바구니" button on a product page, and the cart icon in the mall header. */
  shopAdd: { x: 455, y: 468 },
  shopCart: { x: 1096, y: 147 },
} as const;

export const CURSOR_PATH: readonly Waypoint[] = [
  { frame: 0, x: 620, y: 520 },
  { frame: 18, x: 620, y: 520 },
  { frame: 30, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen, x: EXT.x, y: EXT.y, click: true },
  { frame: 46, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 50, x: HIT.goalInput.x, y: HIT.goalInput.y, click: true },
  { frame: beat.goalTypeEnd, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 116, x: HIT.startBtn.x, y: HIT.startBtn.y },
  { frame: beat.startClick, x: HIT.startBtn.x, y: HIT.startBtn.y, click: true },
  { frame: 142, x: 640, y: 430 },

  // S2 — music on, read, check the numbers, then Cmd-Tab into the writing app
  { frame: beat.newsEnter - 8, x: tabX(1, 3), y: TAB_Y },
  { frame: beat.newsEnter, x: tabX(1, 3), y: TAB_Y, click: true },
  { frame: beat.statsEnter - 8, x: tabX(2, 3), y: TAB_Y },
  { frame: beat.statsEnter, x: tabX(2, 3), y: TAB_Y, click: true },
  { frame: 222, x: 600, y: 430 },
  { frame: beat.switchToEditor1 + 6, x: 600, y: 430, hidden: true },

  // S3 — back to the browser, then into the messages
  { frame: beat.switchToBrowser1 + 8, x: 620, y: 300, hidden: false },
  { frame: beat.igEnter - 6, x: HIT.newTab.x, y: HIT.newTab.y },
  { frame: beat.igEnter, x: HIT.newTab.x, y: HIT.newTab.y, click: true },
  { frame: beat.igEnter + 16, x: 660, y: 420 },
  { frame: beat.igDmEnter - 6, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y },
  { frame: beat.igDmEnter, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y, click: true },
  { frame: beat.igDmEnter + 16, x: 820, y: 700 },
  { frame: 404, x: HIT.toastClose.x, y: HIT.toastClose.y },
  { frame: beat.nudge1Dismiss, x: HIT.toastClose.x, y: HIT.toastClose.y, click: true },
  { frame: beat.nudge1Dismiss + 14, x: 820, y: 700 },

  // S4 — pressing "5분만", then the shopping spree
  { frame: 468, x: HIT.toastBreak.x, y: HIT.toastBreak.y },
  { frame: beat.snoozeClick, x: HIT.toastBreak.x, y: HIT.toastBreak.y, click: true },
  { frame: beat.portalEnter + 10, x: 300, y: 500 },
  { frame: beat.shopEnter - 14, x: HIT.portalAd.x, y: HIT.portalAd.y },
  { frame: beat.shopEnter - 2, x: HIT.portalAd.x, y: HIT.portalAd.y, click: true },
  // Parked on "장바구니" through the spree — the cart badge does the talking.
  { frame: beat.shopEnter + 8, x: HIT.shopAdd.x, y: HIT.shopAdd.y },
  { frame: beat.cartViewEnter - 6, x: HIT.shopAdd.x, y: HIT.shopAdd.y },
  { frame: beat.cartViewEnter, x: HIT.shopCart.x, y: HIT.shopCart.y, click: true },
  { frame: beat.cartViewEnter + 14, x: 700, y: 430 },
  // Hold dead still across the freeze — any drift undercuts the pause.
  { frame: beat.freezeEnd, x: 700, y: 430 },

  // S5 — closing the mess, one tab at a time (each close slides the next into place)
  { frame: beat.closeTab1 - 6, x: tabCloseX(3, 6), y: TAB_Y },
  { frame: beat.closeTab1, x: tabCloseX(3, 6), y: TAB_Y, click: true },
  { frame: beat.closeTab2, x: tabCloseX(3, 6), y: TAB_Y, click: true },
  { frame: beat.closeTab3, x: tabCloseX(3, 6), y: TAB_Y, click: true },
  { frame: beat.returnToGoalTab, x: tabX(2, 3), y: TAB_Y, click: true },
  { frame: 766, x: 600, y: 430 },

  // S6 — praise lands, then Cmd-Tab back to writing
  { frame: beat.switchToEditor2 + 6, x: 600, y: 430, hidden: true },

  // S7 — Cmd-Tab back, compose, send, then end the session
  { frame: beat.switchToBrowser2 + 6, x: 620, y: 300, hidden: false },
  { frame: beat.mailOpen - 8, x: HIT.newTab.x, y: HIT.newTab.y },
  { frame: beat.mailOpen - 2, x: HIT.newTab.x, y: HIT.newTab.y, click: true },
  { frame: beat.sendClick - 10, x: HIT.mailSend.x, y: HIT.mailSend.y },
  { frame: beat.sendClick, x: HIT.mailSend.x, y: HIT.mailSend.y, click: true },
  { frame: beat.popupOpen2 - 6, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen2, x: EXT.x, y: EXT.y, click: true },
  { frame: beat.endSessionClick - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
  { frame: beat.endSessionClick, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y, click: true },
  { frame: 968, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
];

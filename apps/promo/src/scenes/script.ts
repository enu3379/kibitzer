import { Easing } from "remotion";
import {
  CONTENT_H,
  DotKind,
  TABSTRIP_H,
  TABSTRIP_LEFT,
  TOAST,
  TOAST_SCALE,
  TOOLBAR_H,
  WINDOW,
} from "../theme";
import {
  DocBlock,
  GOAL,
  GOAL_BUDGET_MIN,
  dashboard,
  nudge,
  omniSocial,
  praise,
  report,
  researchQuery,
  tabs as tabTitles,
} from "../copy";
import { SWITCHER_FRAMES, beat, clockAt, scene } from "../timeline";
import { between, progress, range, toastEase } from "../lib/anim";
import { typed } from "../lib/typewriter";
import { Waypoint } from "../lib/cursor";
import { OmniState, TabSpec, tabBaseWidth, tabCloseX } from "../components/browser/BrowserWindow";
import { PopupState } from "../components/extension/ExtensionPopup";
import { HotButton } from "../components/toast/Toast";
import { AppKey } from "../components/desktop/AppSwitcher";
import { KeyHintState } from "../components/KeyHint";

/* ------------------------------------------------------------------ types */

export type PageKind =
  | { k: "newtab" }
  | { k: "news"; scroll: number; variant: number; select: number }
  | { k: "stats"; reveal: number; select: number }
  | { k: "tube"; video: number; progress: number }
  | { k: "igFeed"; scroll: number }
  | {
      k: "igDm";
      thread: number;
      messages: number;
      typing: boolean;
      badge: number;
      unreadRows: number;
      flashThread: number | null;
      composing: string;
      linkHot: boolean;
    }
  | { k: "portal"; query: string; adHot: number | null }
  | {
      k: "shop";
      view: "list" | "detail" | "cart";
      listScroll: number;
      listHot: number | null;
      product: number;
      cart: number;
      cartPulse: number;
      cartItems: number[];
      addHot: boolean;
    }
  | { k: "mail"; reveal: number; sendHot: boolean; sent: boolean };

export type EditorState = {
  blocks: DocBlock[];
  caret: boolean;
  pasteFlash: number;
  scroll: number;
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
  omni: OmniState | null;
  dot: DotKind;
  page: PageKind;
  popup: { state: PopupState; reveal: number } | null;
  toast: ToastState | null;
  keyHint: KeyHintState | null;
  zoom: number;
};

/* ------------------------------------------------------------------ fixtures */

const TAB = {
  newtab: { id: "newtab", site: "newtab", title: "새 탭" },
  news: { id: "news", site: "news", title: tabTitles.news },
  stats: { id: "stats", site: "stats", title: tabTitles.stats },
  insta: { id: "insta", site: "insta", title: tabTitles.insta },
  /** Opened from a link inside a message thread, not chosen off a homepage. */
  music: { id: "music", site: "tube", title: tabTitles.music },
  portal: { id: "portal", site: "portal", title: tabTitles.portal },
  shop: { id: "shop", site: "shop", title: tabTitles.shop },
  research: { id: "research", site: "news", title: tabTitles.research },
  mail: { id: "mail", site: "mail", title: tabTitles.mail },
} as const satisfies Record<string, TabSpec>;

const URL = {
  newtab: "새 탭",
  news: "commerceweekly.com/analysis/how-marketplaces-buy-their-first-million-customers",
  stats: "app.marketpulse.io/acquisition/channels",
  igFeed: "gramline.com/",
  igDm: "gramline.com/direct/inbox",
  music: "metube.com/watch?v=8kR2vQ",
  portal: "narae.com/search?query=러닝화+추천",
  shopList: "shop.daylight.co.kr/deals/today",
  shopCart: "shop.daylight.co.kr/cart",
  research: "commerceweekly.com/data/membership-retention-benchmarks-2026",
  mail: "mail.workspace.com/u/0/#compose",
} as const;

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

/** Nudge toasts span scene boundaries, so composing one is a shared helper. */
const nudgeToast = (
  frame: number,
  copy: { message: string; context: string },
  inAt: number,
  outAt: number,
  extra: Partial<ToastState> = {},
): ToastState | null => {
  const enter = toastEnter(frame, inAt);
  const exit = toastExit(frame, outAt);
  const reveal = Math.min(enter.reveal, exit.reveal);
  if (reveal <= 0) return null;
  return {
    celebration: false,
    message: copy.message,
    context: copy.context,
    reveal,
    lift: Math.max(enter.lift, exit.lift),
    peek: enter.peek,
    hotButton: null,
    closeHot: false,
    ...extra,
  };
};

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

/* ------------------------------------------------------------------ the document */

const B = report.blocks;
const GAP: DocBlock = { t: "gap" };

type WriteEvent = { at: number; fpc?: number; paste?: boolean; block: DocBlock };

/**
 * The whole report, as a schedule. Two of the twelve entries are pastes — they land
 * whole, which is what makes them read as pastes rather than as very fast typing.
 * `writeP3` is deliberately the slowest block: it is where the momentum runs out.
 */
const WRITING: readonly WriteEvent[] = [
  { at: beat.writeH1, fpc: 0.9, block: B.h1 },
  { at: beat.writeP1, fpc: 0.5, block: B.p1 },
  { at: beat.paste1, paste: true, block: B.q1 },
  { at: beat.writeH2, fpc: 0.9, block: B.h2 },
  { at: beat.writeP2, fpc: 0.5, block: B.p2 },
  { at: beat.paste2, paste: true, block: B.q2 },
  { at: beat.writeP3, fpc: 0.8, block: B.p3 },
  { at: beat.enter1, block: GAP },
  { at: beat.enter2, block: GAP },
  { at: beat.writeH3, fpc: 0.9, block: B.h3 },
  { at: beat.writeP4, fpc: 0.5, block: B.p4 },
  { at: beat.chartIn, block: B.chart },
];

/** Rough laid-out height of a block, used only to decide when the page has to scroll. */
const blockH = (b: DocBlock): number => {
  switch (b.t) {
    case "h":
      return 38;
    case "p":
      return 4 + Math.max(1, Math.ceil(Array.from(b.text).length / 33)) * 24;
    case "quote":
      return 59 + b.text.split("\n").length * 20;
    case "gap":
      return 24;
    case "chart":
      return 163;
  }
};

/** Title + subtitle, and the text height the editor window can show at once. */
const DOC_HEAD = 70;
const DOC_VIEW = 622;

const docAt = (frame: number): EditorState => {
  const blocks: DocBlock[] = [];
  let typing = false;
  let pasteFlash = 0;

  for (const ev of WRITING) {
    if (frame < ev.at) break;
    typing = false;
    if (ev.paste) {
      blocks.push(ev.block);
      pasteFlash = range(frame, [ev.at, ev.at + 10], [1, 0], Easing.linear);
      continue;
    }
    if (ev.block.t === "gap" || ev.block.t === "chart") {
      blocks.push(ev.block);
      continue;
    }
    const full = ev.block.text;
    const shown = typed(full, frame, ev.at - 1, ev.fpc ?? 0.6);
    blocks.push({ ...ev.block, text: shown });
    typing = Array.from(shown).length < Array.from(full).length;
  }

  const height = DOC_HEAD + blocks.reduce((sum, b) => sum + blockH(b), 0);
  return {
    blocks,
    // Solid while typing; a plain blinking caret once the writing stops.
    caret: typing || Math.floor(frame / 16) % 2 === 0,
    pasteFlash,
    scroll: Math.max(0, height + 40 - DOC_VIEW),
  };
};

/* ------------------------------------------------------------------ keystroke chips */

const KEY_HINTS: ReadonlyArray<{ at: number; label: string }> = [
  { at: beat.copy1, label: "⌘ C" },
  { at: beat.paste1, label: "⌘ V" },
  { at: beat.copy2, label: "⌘ C" },
  { at: beat.paste2, label: "⌘ V" },
  { at: beat.enter1, label: "⏎" },
  { at: beat.enter2, label: "⏎" },
  { at: beat.omniTab, label: "Tab" },
];

const keyHintAt = (frame: number): KeyHintState | null => {
  for (const k of KEY_HINTS) {
    const opacity = Math.min(range(frame, [k.at - 3, k.at], [0, 1]), range(frame, [k.at + 10, k.at + 18], [1, 0]));
    if (opacity > 0.02) return { label: k.label, opacity };
  }
  return null;
};

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

/* ------------------------------------------------------------------ S2 — the research loop */

/**
 * Three round trips between the browser and the writing app, each tighter than the last.
 * Trip 2 and 3 carry the copy-paste; the clock jumps ~15 minutes per trip, which is what
 * turns eleven seconds of screen time into an hour of work.
 *
 * Then it decelerates: the last paragraph is typed at almost half speed, two Enters, and
 * fifty frames of nothing but a caret. That gap is the whole reason the next scene works.
 */
const s2 = (frame: number, st: Stage): void => {
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
  st.dot = "none";
  st.focus = "browser";

  if (frame < beat.statsEnter) {
    st.activeId = "news";
    st.url = URL.news;
    st.page = {
      k: "news",
      variant: 0,
      scroll: range(frame, [beat.newsEnter + 6, beat.switchToEditor1], [0, 430]),
      select: 0,
    };
  } else if (frame < beat.newsReturn) {
    st.activeId = "stats";
    st.url = URL.stats;
    st.page = {
      k: "stats",
      reveal: progress(frame, beat.statsEnter, 18),
      select: range(frame, [beat.select1, beat.select1 + 9], [0, 1]),
    };
  } else {
    st.activeId = "news";
    st.url = URL.news;
    st.page = {
      k: "news",
      variant: 0,
      scroll: range(frame, [beat.newsReturn, beat.select2 - 4], [430, 820]),
      select: range(frame, [beat.select2, beat.select2 + 9], [0, 1]),
    };
  }

  // The writing app opens on the first Cmd-Tab and stays open for the rest of the video.
  if (frame >= beat.switchToEditor1 - 6) st.editor = docAt(frame);

  applySwitch(frame, st, beat.switchToEditor1, "editor");
  applySwitch(frame, st, beat.switchToBrowser1, "browser");
  applySwitch(frame, st, beat.switchToEditor2, "editor");
  applySwitch(frame, st, beat.switchToBrowser2, "browser");
  applySwitch(frame, st, beat.switchToEditor3, "editor");
};

/* ------------------------------------------------------------------ S3 — drift #1: messages */

/** Unread count and list state keep climbing whether or not the tab is on screen. */
const dmBadge = (frame: number): number => Math.min(28, 3 + Math.floor((frame - beat.igDmEnter) / 16));
const dmUnread = (frame: number): number => Math.min(8, 1 + Math.floor((frame - beat.igDmEnter) / 40));

/** Reply → reply → interrupted mid-reply → the interrupter wins. Three threads, fast. */
type DmSegment = { from: number; thread: number; first: number; last: number; composeAt: number; compose: string };

const dmSegments: readonly DmSegment[] = [
  { from: beat.igDmEnter, thread: 0, first: 4, last: 7, composeAt: beat.dmReply1, compose: "ㅋㅋㅋㅋ 그래서" },
  { from: beat.dmSwitch2, thread: 1, first: 3, last: 6, composeAt: beat.dmReply2, compose: "나 포함 넷?" },
  // The link lands as message 4, a beat after this thread is opened — it has to arrive
  // on screen, not already be sitting there.
  { from: beat.dmSwitch3, thread: 2, first: 3, last: 6, composeAt: beat.dmSwitch3 + 7, compose: "오 뭔데" },
  { from: beat.dmReturn, thread: 2, first: 6, last: 6, composeAt: -1, compose: "" },
  // The two trips back mid-spree. A different thread is open each time — look away for
  // three minutes and it is somebody else you are now mid-conversation with.
  { from: beat.dmPeek1, thread: 3, first: 5, last: 8, composeAt: -1, compose: "" },
  { from: beat.dmPeek2, thread: 5, first: 3, last: 6, composeAt: -1, compose: "" },
];

const dmPage = (frame: number): PageKind => {
  let seg = dmSegments[0];
  for (const s of dmSegments) if (frame >= s.from) seg = s;
  const step = Math.floor((frame - seg.from) / 9);
  const msgs = Math.min(seg.last, seg.first + step);
  return {
    k: "igDm",
    thread: seg.thread,
    messages: msgs,
    typing: msgs < seg.last && step % 3 === 2,
    badge: dmBadge(frame),
    unreadRows: dmUnread(frame),
    // The row that lights up mid-reply, right before it steals the cursor.
    flashThread: between(frame, beat.dmInterrupt, beat.dmSwitch3) ? 2 : null,
    composing: seg.composeAt >= 0 ? typed(seg.compose, frame, seg.composeAt, 2.2) : "",
    linkHot: between(frame, beat.musicOpen - 6, beat.musicOpen + 3),
  };
};

const s3 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "editor";
  applySwitch(frame, st, beat.switchToBrowser3, "browser");

  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
  st.activeId = "stats";
  st.url = URL.stats;
  st.page = { k: "stats", reveal: 1, select: 0 };
  st.dot = "none";

  // New tab, one keystroke, autocomplete, Tab. Nobody types a whole hostname any more.
  if (between(frame, beat.newTabClick, beat.igEnter)) {
    st.tabs.push({ ...TAB.newtab });
    st.activeId = "newtab";
    st.url = URL.newtab;
    st.page = { k: "newtab" };
    const done = frame >= beat.omniTab;
    st.omni = {
      typed: frame < beat.omniType ? "" : done ? omniSocial.full : omniSocial.typed,
      completion: frame >= beat.omniSuggest && !done ? omniSocial.completion : "",
      suggestion:
        frame >= beat.omniSuggest ? { site: "insta", title: tabTitles.insta, url: omniSocial.full } : null,
    };
    return;
  }
  if (frame < beat.igEnter) return;

  st.tabs.push({ ...TAB.insta });
  st.activeId = "insta";

  if (frame < beat.igDmEnter) {
    st.url = URL.igFeed;
    st.page = { k: "igFeed", scroll: range(frame, [beat.igEnter + 6, beat.igDmEnter], [0, 230], Easing.linear) };
  } else {
    st.url = URL.igDm;
    st.page = dmPage(frame);
  }

  // The link someone dropped in the thread opens in its own tab and keeps playing.
  if (frame >= beat.musicOpen) {
    st.tabs.push({ ...TAB.music });
    if (frame < beat.dmReturn) {
      st.activeId = "music";
      st.url = URL.music;
      st.page = { k: "tube", video: 0, progress: range(frame, [beat.musicOpen, beat.dmReturn], [0.02, 0.22], Easing.linear) };
    }
  }

  // The dot only turns red once a nudge is actually pending — matches background.ts.
  st.dot = frame >= beat.dotRed1 ? "red" : "none";

  st.toast = nudgeToast(frame, nudge.first, beat.nudge1In, beat.nudge1Dismiss, {
    closeHot: between(frame, beat.nudge1Dismiss - 6, beat.nudge1Dismiss + 2),
  });
};

/* ------------------------------------------------------------------ S4 — drift #2/#3: the mall */

/** Which product goes in the cart, in the order it is added. Scattered on purpose. */
const SPREE = [3, 5, 1, 8, 6, 0, 4] as const;
const CART_STEPS = [beat.cart1, beat.cart2, beat.cart3, beat.cart4, beat.cart5, beat.cart6, beat.cart7] as const;

const cartAt = (frame: number) => {
  let added = 0;
  for (const at of CART_STEPS) if (frame >= at) added += 1;
  const last = added > 0 ? CART_STEPS[added - 1] : -999;
  const next = added < CART_STEPS.length ? CART_STEPS[added] : Infinity;
  return {
    count: added,
    items: SPREE.slice(0, added),
    pulse: range(frame, [last, last + 8], [1, 0], Easing.out(Easing.quad)),
    addHot: frame >= next - 5 && frame < next + 2,
    product: SPREE[Math.min(SPREE.length - 1, added)],
  };
};

const onDmPeek = (frame: number): boolean =>
  between(frame, beat.dmPeek1, beat.dmPeek1End) || between(frame, beat.dmPeek2, beat.dmPeek2End);

const s4 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "browser";
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }, { ...TAB.insta }, { ...TAB.music }];
  st.activeId = "insta";
  st.url = URL.igDm;
  st.page = dmPage(frame);
  st.dot = frame < beat.snoozeClick ? "red" : frame < beat.nudge3In ? "blue" : "red";

  if (frame < beat.portalEnter) {
    st.toast = nudgeToast(frame, nudge.second, beat.nudge2In, beat.snoozeClick, {
      hotButton: between(frame, beat.snoozeClick - 8, beat.snoozeClick + 3) ? "break" : null,
    });
    return;
  }

  /*
   * A search on the portal turns into a spree. The cart badge is the clock — 0 → 7 says
   * "time passed" more concretely than any scroll, and it is the payoff of the report's
   * own subject matter. The two trips back to the messages are what make the badge jump:
   * you look away, and both counters have moved.
   */
  st.tabs.push({ ...TAB.portal });
  if (frame < beat.shopEnter) {
    st.activeId = "portal";
    st.url = URL.portal;
    st.page = {
      k: "portal",
      query: typed("러닝화 추천", frame, beat.portalQuery, 2.4),
      adHot: between(frame, beat.shopEnter - 14, beat.shopEnter) ? 0 : null,
    };
    return;
  }

  // The tab title has to agree with the page: browsing deals, then the cart.
  st.tabs.push({ ...TAB.shop, title: frame >= beat.cartViewEnter ? tabTitles.shop : tabTitles.shopList });

  if (onDmPeek(frame)) {
    st.activeId = "insta";
    st.url = URL.igDm;
    st.page = dmPage(frame);
  } else {
    const cart = cartAt(frame);
    const listing = frame < beat.shopPick;
    const cartView = frame >= beat.cartViewEnter;
    st.activeId = "shop";
    st.url = cartView
      ? URL.shopCart
      : listing
        ? URL.shopList
        : `shop.daylight.co.kr/products/${PRODUCT_SLUG[cart.product]}`;
    st.page = {
      k: "shop",
      view: cartView ? "cart" : listing ? "list" : "detail",
      listScroll: range(frame, [beat.shopEnter + 6, beat.shopPick - 4], [0, 96], Easing.linear),
      listHot: between(frame, beat.shopPick - 10, beat.shopPick + 2) ? 3 : null,
      product: cart.product,
      cart: cart.count,
      cartPulse: cartView ? 0 : cart.pulse,
      cartItems: [...cart.items],
      addHot: !cartView && !listing && cart.addHot,
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

/** Address bar has to agree with the product on screen. */
const PRODUCT_SLUG = [
  "stride-air-3",
  "audio-n-buds-anc",
  "outline-camp-chair",
  "dayloop-tumbler-500",
  "plainwear-cotton-hoodie",
  "typebox-fold-keyboard",
  "morning-co-dripbag-30",
  "airleaf-humidifier-4l",
  "typebox-ergo-mouse",
  "plainwear-wash-blanket",
] as const;

/* ------------------------------------------------------------------ S5 — everything stops */

const s5 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "browser";
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }, { ...TAB.insta }, { ...TAB.music }, { ...TAB.portal }, { ...TAB.shop }];
  st.activeId = "shop";
  st.url = URL.shopCart;
  st.dot = "red";
  st.page = {
    k: "shop",
    view: "cart",
    listScroll: 0,
    listHot: null,
    product: 0,
    cart: 7,
    cartPulse: 0,
    cartItems: [...SPREE],
    addHot: false,
  };

  // Everything holds and the frame pushes in 4%. The menu bar stays put.
  st.zoom = Math.min(
    range(frame, [beat.freezeStart, beat.freezeStart + 22], [1, 1.04]),
    range(frame, [beat.freezeEnd, beat.freezeEnd + 20], [1.04, 1]),
  );

  st.toast = nudgeToast(frame, nudge.third, beat.nudge3In, beat.freezeEnd + 4);
};

/* ------------------------------------------------------------------ S6 — clear it, start again */

const collapse = (frame: number, at: number): number => range(frame, [at, at + 8], [1, 0], Easing.in(Easing.cubic));

/** Praise spans the S6/S7 boundary, so both scenes compose it from here. */
const praiseToast = (frame: number): ToastState | null => {
  const enter = toastEnter(frame, beat.praiseIn);
  const exit = toastExit(frame, beat.praiseOut, 10);
  const reveal = Math.min(enter.reveal, exit.reveal);
  if (reveal <= 0) return null;
  return {
    celebration: true,
    message: praise.message,
    reveal,
    lift: Math.max(enter.lift, exit.lift),
    peek: enter.peek,
    hotButton: null,
    closeHot: false,
  };
};

const s6 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "browser";
  st.dot = frame >= beat.returnToGoalTab ? "none" : "red";

  // Everything the session was not about, closed right to left.
  const cleared = frame >= beat.closeTab4 + 8;
  st.tabs = cleared
    ? [{ ...TAB.news }, { ...TAB.stats }]
    : [
        { ...TAB.news },
        { ...TAB.stats },
        { ...TAB.insta, width: collapse(frame, beat.closeTab4) },
        { ...TAB.music, width: collapse(frame, beat.closeTab3) },
        { ...TAB.portal, width: collapse(frame, beat.closeTab2) },
        { ...TAB.shop, width: collapse(frame, beat.closeTab1) },
      ];

  /*
   * Closing the active tab drops you onto its neighbour, so the cleanup is not four
   * identical clicks — the whole afternoon flashes past in reverse on the way out,
   * and the last one lands on the page the session was actually about.
   */
  const closed = [beat.closeTab1, beat.closeTab2, beat.closeTab3, beat.closeTab4].filter((at) => frame >= at + 8).length;
  if (closed === 0) {
    st.activeId = "shop";
    st.url = URL.shopCart;
    st.page = {
      k: "shop",
      view: "cart",
      listScroll: 0,
      listHot: null,
      product: 0,
      cart: 7,
      cartPulse: 0,
      cartItems: [...SPREE],
      addHot: false,
    };
  } else if (closed === 1) {
    st.activeId = "portal";
    st.url = URL.portal;
    st.page = { k: "portal", query: "러닝화 추천", adHot: null };
  } else if (closed === 2) {
    st.activeId = "music";
    st.url = URL.music;
    st.page = { k: "tube", video: 0, progress: 0.4 };
  } else if (closed === 3) {
    st.activeId = "insta";
    st.url = URL.igDm;
    st.page = dmPage(frame);
  } else {
    st.activeId = "stats";
    st.url = URL.stats;
    st.page = { k: "stats", reveal: 1, select: 0 };
  }

  // Open the document — long enough to see the blank line it was abandoned on.
  applySwitch(frame, st, beat.switchToEditor4, "editor");
  applySwitch(frame, st, beat.switchToBrowser4, "browser");

  // Back in the browser, a new question rather than the old page.
  if (frame >= beat.newResearchTab) {
    const loaded = frame >= beat.researchLoad;
    st.tabs.push(loaded ? { ...TAB.research } : { ...TAB.newtab });
    st.activeId = loaded ? "research" : "newtab";
    if (loaded) {
      st.url = URL.research;
      st.page = { k: "news", variant: 1, scroll: range(frame, [beat.researchLoad + 8, scene.s7WrapUp.from], [0, 190]), select: 0 };
    } else {
      st.url = URL.newtab;
      st.page = { k: "newtab" };
      st.omni = { typed: typed(researchQuery, frame, beat.newResearchTab + 2, 0.4), completion: "", suggestion: null };
    }
  }

  // The celebration lands in the browser, on a goal-related page — the extension can
  // only draw inside a tab, so praising here (not in the writing app) stays truthful.
  st.toast = praiseToast(frame);
};

/* ------------------------------------------------------------------ S7 — finish and wrap up */

const s7 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "browser";
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }, { ...TAB.research }];
  st.activeId = "research";
  st.url = URL.research;
  st.page = { k: "news", variant: 1, scroll: 190, select: 0 };
  st.dot = "none";

  st.toast = praiseToast(frame);

  applySwitch(frame, st, beat.switchToEditor5, "editor");
  applySwitch(frame, st, beat.switchToBrowser5, "browser");
  if (frame < SWITCH_AT(beat.switchToBrowser5)) return;

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
    omni: null,
    dot: "none",
    page: { k: "newtab" },
    popup: null,
    toast: null,
    keyHint: null,
    zoom: 1,
  };

  if (frame < scene.s2Research.from) s1(frame, st);
  else if (frame < scene.s3Messages.from) s2(frame, st);
  else if (frame < scene.s4Shopping.from) s3(frame, st);
  else if (frame < scene.s5Freeze.from) s4(frame, st);
  else if (frame < scene.s6Reset.from) s5(frame, st);
  else if (frame < scene.s7WrapUp.from) s6(frame, st);
  else s7(frame, st);

  st.keyHint = keyHintAt(frame);
  return st;
};

/* ------------------------------------------------------------------ cursor path */

const EXT = { x: WINDOW.x + WINDOW.width - 55, y: WINDOW.y + 60 };
const TAB_Y = WINDOW.y + 22;
/** Centre-ish of tab `i`, for clicking the tab itself rather than its ✕. */
const tabX = (i: number, count: number) => tabCloseX(i, count) - tabBaseWidth(count) * 0.45;
/** The "+" button sits just past the last tab. */
const newTabX = (count: number) => WINDOW.x + TABSTRIP_LEFT + tabBaseWidth(count) * count + 18;

/** Toast anchor: bottom-right of the page viewport, inset by TOAST's right/bottom. */
const TOAST_ANCHOR = {
  x: WINDOW.x + WINDOW.width - TOAST.right, // 1112
  y: WINDOW.y + TABSTRIP_H + TOOLBAR_H + CONTENT_H - TOAST.bottom, // 824
};
/** Offsets measured against the 1× card, multiplied by whatever scale the cut uses. */
const toastHit = (dx: number, dy: number) => ({
  x: TOAST_ANCHOR.x + dx * TOAST_SCALE,
  y: TOAST_ANCHOR.y + dy * TOAST_SCALE,
});

/**
 * Hit points inside the popup, toast, pages and mail sheet. Tuned against the rendered
 * stills rather than computed, because most of these boxes are auto-height.
 */
const HIT = {
  goalInput: { x: 928, y: 208 },
  startBtn: { x: 928, y: 330 },
  endSessionBtn: { x: 1003, y: 606 },
  toastClose: toastHit(-24, -118), // 1.5× → (1076, 647)
  toastBreak: toastHit(-144, -28), // 1.5× → (896, 782)
  mailSend: { x: 706, y: 817 },
  /** Direct-message icon in the social app's header. */
  igDmIcon: { x: 1065, y: 144 },
  /** Rows in the thread list. */
  dmRow: [
    { x: 156, y: 239 },
    { x: 156, y: 297 },
    { x: 156, y: 355 },
  ],
  /** The shared music link inside the open thread. */
  dmLink: { x: 415, y: 545 },
  /** Reply box at the bottom of the open conversation. */
  dmCompose: { x: 700, y: 800 },
  /** First product card in the portal's shopping panel — the bridge to the mall. */
  portalAd: { x: 133, y: 419 },
  /** Fourth card in the mall's listing grid, after a scroll. */
  shopCard: { x: 790, y: 330 },
  /** "장바구니" button on a product page, and the cart icon in the mall header. */
  shopAdd: { x: 455, y: 468 },
  shopCart: { x: 1096, y: 147 },
  /** Roughly the middle of the article column, for reading scrolls. */
  read: { x: 600, y: 470 },
} as const;

/** Nudges the pointer a few px so parked stretches do not look frozen. */
const idle = (frame: number, x: number, y: number): Waypoint => ({ frame, x, y });

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

  /* ---------------------------------------------------------------- S2 research loop */
  { frame: beat.newsEnter - 8, x: tabX(0, 2), y: TAB_Y },
  { frame: beat.newsEnter, x: tabX(0, 2), y: TAB_Y, click: true },
  idle(beat.newsEnter + 14, HIT.read.x, HIT.read.y),
  { frame: beat.switchToEditor1 + 6, x: HIT.read.x, y: HIT.read.y, hidden: true },

  { frame: beat.switchToBrowser1 + 7, x: tabX(1, 2), y: TAB_Y, hidden: false },
  { frame: beat.statsEnter, x: tabX(1, 2), y: TAB_Y, click: true },
  // Drag-select the two rows that get pasted, then copy. Endpoints measured off the
  // rendered dashboard: the table rows sit at y≈384 and y≈480.
  { frame: beat.select1 - 4, x: 676, y: 376 },
  { frame: beat.select1 + 9, x: 1092, y: 488 },
  { frame: beat.copy1, x: 1092, y: 488 },
  { frame: beat.switchToEditor2 + 6, x: 1092, y: 488, hidden: true },

  { frame: beat.switchToBrowser2 + 7, x: tabX(0, 2), y: TAB_Y, hidden: false },
  { frame: beat.newsReturn, x: tabX(0, 2), y: TAB_Y, click: true },
  // The pull quote sits at y≈291–322 once the article is scrolled to 820.
  { frame: beat.select2 - 4, x: 295, y: 288 },
  { frame: beat.select2 + 9, x: 855, y: 322 },
  { frame: beat.copy2, x: 855, y: 322 },
  { frame: beat.switchToEditor3 + 6, x: 855, y: 322, hidden: true },

  /* ---------------------------------------------------------------- S3 messages */
  { frame: beat.switchToBrowser3 + 7, x: 620, y: 300, hidden: false },
  { frame: beat.newTabClick - 6, x: newTabX(2), y: TAB_Y },
  { frame: beat.newTabClick, x: newTabX(2), y: TAB_Y, click: true },
  idle(beat.igEnter + 10, 660, 430),
  { frame: beat.igDmEnter - 6, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y },
  { frame: beat.igDmEnter, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y, click: true },
  { frame: beat.dmReply1 - 4, x: HIT.dmCompose.x, y: HIT.dmCompose.y },
  { frame: beat.dmReply1, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  { frame: beat.dmSwitch2 - 5, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y },
  { frame: beat.dmSwitch2, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y, click: true },
  { frame: beat.dmReply2, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  // Interrupted mid-reply: the third row lights up and wins.
  { frame: beat.dmSwitch3 - 5, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y },
  { frame: beat.dmSwitch3, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y, click: true },
  { frame: beat.musicOpen - 8, x: HIT.dmLink.x, y: HIT.dmLink.y },
  { frame: beat.musicOpen, x: HIT.dmLink.x, y: HIT.dmLink.y, click: true },
  idle(beat.musicOpen + 20, 640, 470),
  { frame: beat.dmReturn - 6, x: tabX(2, 4), y: TAB_Y },
  { frame: beat.dmReturn, x: tabX(2, 4), y: TAB_Y, click: true },
  idle(beat.dmReturn + 16, 820, 700),
  { frame: beat.nudge1Dismiss - 10, x: HIT.toastClose.x, y: HIT.toastClose.y },
  { frame: beat.nudge1Dismiss, x: HIT.toastClose.x, y: HIT.toastClose.y, click: true },
  idle(beat.nudge1Dismiss + 14, 820, 700),

  /* ---------------------------------------------------------------- S4 the mall */
  { frame: beat.snoozeClick - 12, x: HIT.toastBreak.x, y: HIT.toastBreak.y },
  { frame: beat.snoozeClick, x: HIT.toastBreak.x, y: HIT.toastBreak.y, click: true },
  { frame: beat.portalEnter - 6, x: newTabX(4), y: TAB_Y },
  { frame: beat.portalEnter, x: newTabX(4), y: TAB_Y, click: true },
  { frame: beat.shopEnter - 12, x: HIT.portalAd.x, y: HIT.portalAd.y },
  { frame: beat.shopEnter - 2, x: HIT.portalAd.x, y: HIT.portalAd.y, click: true },
  { frame: beat.shopEnter + 16, x: 640, y: 500 },
  { frame: beat.shopPick - 8, x: HIT.shopCard.x, y: HIT.shopCard.y },
  { frame: beat.shopPick, x: HIT.shopCard.x, y: HIT.shopCard.y, click: true },
  // Parked on "장바구니" through the spree — the badge does the talking.
  { frame: beat.cart1, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart2, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek1 - 5, x: tabX(2, 6), y: TAB_Y },
  { frame: beat.dmPeek1, x: tabX(2, 6), y: TAB_Y, click: true },
  idle(beat.dmPeek1 + 16, 700, 620),
  { frame: beat.dmPeek1End - 5, x: tabX(5, 6), y: TAB_Y },
  { frame: beat.dmPeek1End, x: tabX(5, 6), y: TAB_Y, click: true },
  { frame: beat.cart3, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart4, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart5, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek2 - 5, x: tabX(2, 6), y: TAB_Y },
  { frame: beat.dmPeek2, x: tabX(2, 6), y: TAB_Y, click: true },
  idle(beat.dmPeek2 + 14, 700, 620),
  { frame: beat.dmPeek2End - 5, x: tabX(5, 6), y: TAB_Y },
  { frame: beat.dmPeek2End, x: tabX(5, 6), y: TAB_Y, click: true },
  { frame: beat.cart6, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart7, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cartViewEnter, x: HIT.shopCart.x, y: HIT.shopCart.y, click: true },
  { frame: beat.cartViewEnter + 14, x: 700, y: 430 },
  // Dead still across the freeze — any drift undercuts the pause.
  { frame: beat.freezeEnd, x: 700, y: 430 },

  /* ---------------------------------------------------------------- S6 clear + restart */
  { frame: beat.closeTab1 - 8, x: tabCloseX(5, 6), y: TAB_Y },
  { frame: beat.closeTab1, x: tabCloseX(5, 6), y: TAB_Y, click: true },
  { frame: beat.closeTab2, x: tabCloseX(4, 6), y: TAB_Y, click: true },
  { frame: beat.closeTab3, x: tabCloseX(3, 6), y: TAB_Y, click: true },
  { frame: beat.closeTab4, x: tabCloseX(2, 6), y: TAB_Y, click: true },
  // No click needed — closing the last stray tab already lands on the goal-related one.
  { frame: beat.returnToGoalTab, x: tabX(1, 2), y: TAB_Y },
  { frame: beat.switchToEditor4 + 6, x: 600, y: 430, hidden: true },
  { frame: beat.switchToBrowser4 + 7, x: 620, y: 300, hidden: false },
  { frame: beat.newResearchTab - 6, x: newTabX(2), y: TAB_Y },
  { frame: beat.newResearchTab, x: newTabX(2), y: TAB_Y, click: true },
  idle(beat.researchLoad + 12, HIT.read.x, HIT.read.y),

  /* ---------------------------------------------------------------- S7 wrap up */
  { frame: beat.switchToEditor5 + 6, x: HIT.read.x, y: HIT.read.y, hidden: true },
  { frame: beat.switchToBrowser5 + 7, x: 620, y: 300, hidden: false },
  { frame: beat.mailOpen - 8, x: newTabX(3), y: TAB_Y },
  { frame: beat.mailOpen - 2, x: newTabX(3), y: TAB_Y, click: true },
  { frame: beat.sendClick - 10, x: HIT.mailSend.x, y: HIT.mailSend.y },
  { frame: beat.sendClick, x: HIT.mailSend.x, y: HIT.mailSend.y, click: true },
  { frame: beat.popupOpen2 - 6, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen2, x: EXT.x, y: EXT.y, click: true },
  { frame: beat.endSessionClick - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
  { frame: beat.endSessionClick, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y, click: true },
  { frame: beat.endCardIn - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
];

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
import { layout, scrollFor } from "../lib/doclayout";
import { Waypoint } from "../lib/cursor";
import { OmniState, TabSpec, tabBaseWidth, tabCloseX } from "../components/browser/BrowserWindow";
import { PopupState } from "../components/extension/ExtensionPopup";
import { HotButton } from "../components/toast/Toast";
import { AppKey } from "../components/desktop/AppSwitcher";
import { KeyHintState } from "../components/KeyHint";
import { SEARCHES } from "../components/sites/SearchMock";

/* ------------------------------------------------------------------ types */

export type PageKind =
  | { k: "newtab" }
  | { k: "news"; scroll: number; variant: number; select: number }
  | { k: "search"; set: number; query: string; hot: number | null }
  | { k: "stats"; reveal: number; select: number; view: "acquisition" | "cohorts" }
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
  /** The results page the research keeps coming back to. */
  search: { id: "search", site: "search", title: tabTitles.search },
  news: { id: "news", site: "news", title: tabTitles.news },
  stats: { id: "stats", site: "stats", title: tabTitles.stats },
  cohorts: { id: "cohorts", site: "stats", title: tabTitles.cohorts },
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
  search: "search.norra.com/?q=",
  news: "commerceweekly.com/analysis/how-marketplaces-buy-their-first-million-customers",
  stats: "app.marketpulse.io/acquisition/channels",
  cohorts: "app.marketpulse.io/cohorts/retention",
  igFeed: "gramline.com/",
  igDm: "gramline.com/direct/inbox",
  music: "metube.com/watch?v=8kR2vQ",
  portal: "narae.com/search?query=러닝화+추천",
  shopList: "shop.daylight.co.kr/deals/today",
  shopCart: "shop.daylight.co.kr/cart",
  research: "commerceweekly.com/data/membership-retention-benchmarks-2026",
  mail: "mail.workspace.com/u/0/#compose",
} as const;

/**
 * Article scroll positions for the first source.
 *
 * `NEWS_QUOTE` is the offset that puts the pull quote under the drag in CURSOR_PATH. It
 * is tuned against the render rather than computed — the article's block heights depend
 * on how the browser wraps 15px Latin in a 600px column, and nothing here reads back from
 * the DOM. Editing anything above the quote in NewsMock moves it, and the check is
 * `node scripts/render-stills.mjs s2-select-news`.
 *
 * `NEWS_READ` is where the first read stops: mid-argument, before the quote, so coming
 * back for it later is a return rather than a re-run.
 */
const NEWS_READ = 430;
const NEWS_QUOTE = 1020;

/**
 * The second article, read after the return. Scrolled far enough to land on its GMV-band
 * table rather than its lede — that table is what §4 is written from four beats later, so
 * it has to be the thing on screen, and it has to clear the praise toast in the bottom
 * right corner.
 */
const RESEARCH_SCROLL = 500;

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

type WriteEvent = {
  at: number;
  block: DocBlock;
  /** Lands whole: a paste, or a block written behind the browser window. */
  whole?: boolean;
  /** Pastes flash blue for a few frames; plain off-camera writing does not. */
  paste?: boolean;
  /** Spend the entire gap before the next block, however slow that turns out to be. */
  linger?: boolean;
};

/**
 * The whole report, as a schedule.
 *
 * One hard constraint shapes all of it: the writing app is frontmost for well under two
 * hundred frames in the entire film, nowhere near enough to type five pages. So blocks
 * come in two kinds.
 *
 * TYPED — written while the writing app is on screen. Each one gets exactly the gap
 * before the next block, so the rate is *derived* rather than tuned (see `rateFor`).
 * That matters because this timeline gets re-paced: a hard-coded 0.25 that was right at
 * 54 seconds silently overruns its cut at 32, and the paragraph after it starts growing
 * on top of the one still being written. Deriving the rate cannot drift out of sync.
 * It also caps how long a typed block may be: past RATE_MIN the text stops reading as
 * writing, so the on-camera blocks stay at 20–50 characters and say the quotable things.
 *
 * WHOLE — `whole: true`. Its beat sits inside a stretch where the browser covers the
 * writing app, so it simply exists again by the time the next Cmd-Tab lands. That is the
 * quarter hour the menu-bar clock spins through: off camera, the writer kept writing.
 * These carry the volume — the method, the caveats, the cohort reading, the size-band
 * analysis — and because they land whole rather than at some very fast rate, no retime
 * can make one of them spill into view half-finished. Several may share one beat: they
 * are invisible either way, and grouping them keeps the schedule readable.
 *
 * Off-camera windows, i.e. every stretch where a `whole` block may be scheduled:
 *   114–143   §1 body, §2.1–2.4      (clock 2:11 → 2:33)
 *   170–190   §3.1, and the §3.2 head (clock 2:33 → 2:55)
 *   202–218   §3.2 tail, [자료 2], §3.3
 *   751–795   §3.4, §4                (clock 3:31 → 3:38, after the return)
 * Anything scheduled outside one of those pops onto a visible document.
 *
 * The result is a page or more of new text per editor cut, and a document that has
 * reached four dense pages by the time attention goes.
 *
 * `writeP11` lingers: it is where the momentum runs out, so it is given the whole gap
 * before the two Enters no matter how long that gap is.
 */
const WRITING: readonly WriteEvent[] = [
  /* cycle A — the document starts empty */
  { at: beat.writeH1, block: B.s1h },
  { at: beat.writeP1, block: B.s1p1 },
  { at: beat.writeP2, block: B.s1p2 },
  /* off camera — the rest of §1 */
  { at: beat.writeIntroBody, whole: true, block: B.s1p3 },
  { at: beat.writeIntroBody, whole: true, block: B.s1p4 },
  { at: beat.writeIntroBody, whole: true, block: B.s1p5 },
  { at: beat.writeIntroBody, whole: true, block: B.s1p6 },
  { at: beat.writeIntroBody, whole: true, block: B.s1rq },
  /* off camera — §2, method */
  { at: beat.writeMethod, whole: true, block: B.s2h },
  { at: beat.writeMethod, whole: true, block: B.s2h1 },
  { at: beat.writeMethod, whole: true, block: B.s2p1 },
  { at: beat.writeMethod, whole: true, block: B.s2h2 },
  { at: beat.writeMethod, whole: true, block: B.s2p2 },
  { at: beat.writeMethod, whole: true, block: B.s2h3 },
  { at: beat.writeMethod, whole: true, block: B.s2p3 },
  /* off camera — §2.4, ending on the sentence the pasted table lands under */
  { at: beat.writeStats, whole: true, block: B.s2h4 },
  { at: beat.writeStats, whole: true, block: B.s2p4 },
  { at: beat.writeStats, whole: true, block: B.s2p5 },
  /* cycle B */
  { at: beat.paste1, whole: true, paste: true, block: B.s2q },
  { at: beat.writeH2, block: B.s3h },
  { at: beat.writeP6, block: B.s3p1 },
  /* off camera — §3.1, plus the sub-head the next typed block opens under */
  { at: beat.writeCoupon, whole: true, block: B.s3h1 },
  { at: beat.writeCoupon, whole: true, block: B.s3p2 },
  { at: beat.writeCoupon, whole: true, block: B.s3p3 },
  { at: beat.writeCoupon, whole: true, block: B.s3h2 },
  /* cycle C — typed on camera, at the fastest rate in the film */
  { at: beat.writeP8, block: B.s3p4 },
  /* off camera — §3.2 tail, the cohort table, §3.3 */
  { at: beat.writeCuration, whole: true, block: B.s3p5 },
  { at: beat.writeCuration, whole: true, block: B.s3q1 },
  { at: beat.writeCuration, whole: true, block: B.s3p6 },
  { at: beat.writeCuration, whole: true, block: B.s3h3 },
  { at: beat.writeCuration, whole: true, block: B.s3p7 },
  { at: beat.writeCuration, whole: true, block: B.s3p8 },
  { at: beat.writeCuration, whole: true, block: B.s3p9 },
  /* coming back down — and then the pace comes off the boil */
  { at: beat.paste2, whole: true, paste: true, block: B.s3q2 },
  { at: beat.writeP10, block: B.s3p10 },
  { at: beat.writeP11, linger: true, block: B.s3p11 },
  { at: beat.enter1, whole: true, block: GAP },
  { at: beat.enter2, whole: true, block: GAP },
  /* off camera, after the return — §3.4 finishes the interrupted thought, then §4 */
  { at: beat.writeSynthesis, whole: true, block: B.s3h4 },
  { at: beat.writeSynthesis, whole: true, block: B.s3p12 },
  { at: beat.writeSynthesis, whole: true, block: B.s3p13 },
  { at: beat.writeRetention, whole: true, block: B.s4h },
  { at: beat.writeRetention, whole: true, block: B.s4p1 },
  { at: beat.writeRetention, whole: true, block: B.s4p2 },
  { at: beat.writeRetention, whole: true, block: B.chart },
  /* S7 — the conclusion, typed on camera, and then the bibliography closes the document */
  { at: beat.writeH3, block: B.s5h },
  { at: beat.writeP12, block: B.s5p1 },
  { at: beat.writeP13, block: B.s5p2 },
  { at: beat.writeP14, block: B.s5p3 },
  { at: beat.chartIn, whole: true, block: B.refs },
];

/**
 * Frames per character for a typed block: its whole gap, spread over its characters.
 *
 * The clamp is the only judgement in here. Below RATE_MIN the text stops reading as
 * writing and starts reading as a paste — which the pasted blocks already own, and which
 * would make the ⌘V beat meaningless. Above RATE_MAX a short block would crawl. A
 * `linger` block ignores the ceiling, because being slow is the whole point of it.
 */
const RATE_MIN = 0.1; // ≈300 chars/s — dozens of characters per tenth of a second
const RATE_MAX = 0.45; // ≈65 chars/s
const TAIL = 90; // gap assumed for the last block in the list

const rateFor = (i: number): number => {
  const ev = WRITING[i];
  const chars = Array.from(ev.block.t === "h" || ev.block.t === "p" ? ev.block.text : "").length;
  if (chars === 0) return RATE_MAX;
  const gap = (WRITING[i + 1]?.at ?? ev.at + TAIL) - ev.at - 1;
  const fitted = gap / chars;
  if (ev.linger) return Math.max(RATE_MIN, fitted);
  return Math.max(RATE_MIN, Math.min(RATE_MAX, fitted));
};

const docAt = (frame: number): EditorState => {
  const blocks: DocBlock[] = [];
  let typing = false;
  let pasteFlash = 0;

  for (let i = 0; i < WRITING.length; i++) {
    const ev = WRITING[i];
    if (frame < ev.at) break;
    typing = false;
    if (ev.paste) pasteFlash = range(frame, [ev.at, ev.at + 10], [1, 0], Easing.linear);
    if (ev.whole || (ev.block.t !== "h" && ev.block.t !== "p")) {
      blocks.push(ev.block);
      continue;
    }
    const full = ev.block.text;
    const shown = typed(full, frame, ev.at - 1, rateFor(i));
    blocks.push({ ...ev.block, text: shown });
    typing = Array.from(shown).length < Array.from(full).length;
  }

  return {
    blocks,
    // Solid while typing; a plain blinking caret once the writing stops.
    caret: typing || Math.floor(frame / 16) % 2 === 0,
    pasteFlash,
    scroll: scrollFor(layout(blocks).caretY),
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

/**
 * The newest chip wins. ⌘C and ⌘V now land nine frames apart, so returning the first
 * match would leave the copy chip fading over the paste it is supposed to have caused —
 * and the paste is the one beat that needs its key named.
 */
const keyHintAt = (frame: number): KeyHintState | null => {
  let hint: KeyHintState | null = null;
  for (const k of KEY_HINTS) {
    const opacity = Math.min(range(frame, [k.at - 3, k.at], [0, 1]), range(frame, [k.at + 10, k.at + 18], [1, 0]));
    if (opacity > 0.02) hint = { label: k.label, opacity };
  }
  return hint;
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
            goal: typed(GOAL, frame, beat.goalTypeStart, 1.55),
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
 * Four round trips between the browser and the writing app, across three source tabs.
 *
 * Paced as a parabola. Trip 1 reads at a speed you can follow; trips 2–4 tighten until
 * the cohorts page is on screen for fifteen frames, which is exactly what the middle of
 * a long working stretch feels like from the outside. Then it comes back down: the last
 * paragraph is typed four times slower than the ones before it, two Enters, and a third
 * of a second short of a full second with nothing on screen but a caret.
 *
 * The clock runs ~15 minutes per trip, and it runs rather than snapping: each Cmd-Tab
 * into the browser sets the minutes spinning for about half a second before they settle.
 * Only the trips are on camera; the writing that fills those minutes happens behind the
 * browser window (see WRITING).
 */
/**
 * One search-and-open cycle: results page up, a row goes hot, it is clicked, the source
 * opens in its own tab. Three of these run in S2, each landing a different page.
 */
type Cycle = { searchAt: number; clickAt: number; openAt: number; set: number };

const CYCLES: readonly Cycle[] = [
  { searchAt: beat.searchEnter1, clickAt: beat.result1Click, openAt: beat.newsEnter, set: 0 },
  { searchAt: beat.searchEnter2, clickAt: beat.result2Click, openAt: beat.statsEnter, set: 1 },
  { searchAt: beat.searchEnter3, clickAt: beat.result3Click, openAt: beat.cohortsEnter, set: 2 },
];

/** The results page, with the query typed and the row about to be picked highlighted. */
const searchPage = (frame: number, c: Cycle): PageKind => ({
  k: "search",
  set: c.set,
  query: typed(SEARCHES[c.set].query, frame, c.searchAt - 6, 0.16),
  hot: frame >= c.clickAt - 5 ? SEARCHES[c.set].pick : null,
});

const s2 = (frame: number, st: Stage): void => {
  st.dot = "none";
  st.focus = "browser";

  // Tabs accumulate as sources are opened — the strip fills up the way real research does.
  st.tabs = [{ ...TAB.search }];
  if (frame >= beat.newsEnter) st.tabs.push({ ...TAB.news });
  if (frame >= beat.statsEnter) st.tabs.push({ ...TAB.stats });
  if (frame >= beat.cohortsEnter) st.tabs.push({ ...TAB.cohorts });

  // Whichever cycle we are inside decides what the browser is showing.
  if (between(frame, beat.searchEnter1, beat.newsEnter)) {
    st.activeId = "search";
    st.url = URL.search;
    st.page = searchPage(frame, CYCLES[0]);
  } else if (between(frame, beat.searchEnter2, beat.statsEnter)) {
    st.activeId = "search";
    st.url = URL.search;
    st.page = searchPage(frame, CYCLES[1]);
  } else if (between(frame, beat.searchEnter3, beat.cohortsEnter)) {
    st.activeId = "search";
    st.url = URL.search;
    st.page = searchPage(frame, CYCLES[2]);
  } else if (frame < beat.statsEnter) {
    st.activeId = "news";
    st.url = URL.news;
    st.page = { k: "news", variant: 0, scroll: range(frame, [beat.newsEnter + 3, beat.switchToEditor1], [0, NEWS_READ]), select: 0 };
  } else if (frame < beat.cohortsEnter) {
    st.activeId = "stats";
    st.url = URL.stats;
    st.page = {
      k: "stats",
      view: "acquisition",
      reveal: progress(frame, beat.statsEnter, 10),
      select: range(frame, [beat.select1, beat.select1 + 6], [0, 1]),
    };
  } else if (frame < beat.newsReturn) {
    st.activeId = "cohorts";
    st.url = URL.cohorts;
    st.page = { k: "stats", view: "cohorts", reveal: progress(frame, beat.cohortsEnter, 8), select: 0 };
  } else {
    // Back to the first source for the pull quote.
    st.activeId = "news";
    st.url = URL.news;
    st.page = {
      k: "news",
      variant: 0,
      scroll: range(frame, [beat.newsReturn, beat.select2 - 1], [NEWS_READ, NEWS_QUOTE]),
      select: range(frame, [beat.select2, beat.select2 + 6], [0, 1]),
    };
  }

  // The writing app opens on the first Cmd-Tab and stays open for the rest of the video.
  if (frame >= beat.switchToEditor1 - 4) st.editor = docAt(frame);

  applySwitch(frame, st, beat.switchToEditor1, "editor");
  applySwitch(frame, st, beat.switchToBrowser1, "browser");
  applySwitch(frame, st, beat.switchToEditor2, "editor");
  applySwitch(frame, st, beat.switchToBrowser2, "browser");
  applySwitch(frame, st, beat.switchToEditor3, "editor");
  applySwitch(frame, st, beat.switchToBrowser3, "browser");
  applySwitch(frame, st, beat.switchToEditor4, "editor");
};

/* ------------------------------------------------------------------ S3 — drift #1: messages */

/** Unread count and list state keep climbing whether or not the tab is on screen. */
const dmBadge = (frame: number): number => Math.min(28, 3 + Math.floor((frame - beat.igDmEnter) / 11));
const dmUnread = (frame: number): number => Math.min(8, 1 + Math.floor((frame - beat.igDmEnter) / 27));

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
  // A message every 6 frames — fast enough that the log is visibly filling rather than
  // being read. Replies are typed at 1.1 frames per character, for the same reason.
  const step = Math.floor((frame - seg.from) / 6);
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
    composing: seg.composeAt >= 0 ? typed(seg.compose, frame, seg.composeAt, 1.1) : "",
    linkHot: between(frame, beat.musicOpen - 6, beat.musicOpen + 3),
  };
};

const s3 = (frame: number, st: Stage): void => {
  st.editor = docAt(frame);
  st.focus = "editor";
  applySwitch(frame, st, beat.switchToBrowser4, "browser");

  st.tabs = [{ ...TAB.search }, { ...TAB.news }, { ...TAB.stats }, { ...TAB.cohorts }];
  st.activeId = "news";
  st.url = URL.news;
  st.page = { k: "news", variant: 0, scroll: NEWS_QUOTE, select: 0 };
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
    st.page = { k: "igFeed", scroll: range(frame, [beat.igEnter + 4, beat.igDmEnter], [0, 230], Easing.linear) };
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
  st.tabs = [{ ...TAB.search }, { ...TAB.news }, { ...TAB.stats }, { ...TAB.cohorts }, { ...TAB.insta }, { ...TAB.music }];
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
      query: typed("러닝화 추천", frame, beat.portalQuery, 1.1),
      adHot: between(frame, beat.shopEnter - 8, beat.shopEnter) ? 0 : null,
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
      listScroll: range(frame, [beat.shopEnter + 2, beat.shopPick - 3], [0, 96], Easing.linear),
      listHot: between(frame, beat.shopPick - 7, beat.shopPick + 2) ? 3 : null,
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
  st.tabs = [
    { ...TAB.search },
    { ...TAB.news },
    { ...TAB.stats },
    { ...TAB.cohorts },
    { ...TAB.insta },
    { ...TAB.music },
    { ...TAB.portal },
    { ...TAB.shop },
  ];
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
  const RESEARCH = [{ ...TAB.search }, { ...TAB.news }, { ...TAB.stats }, { ...TAB.cohorts }];
  st.tabs = cleared
    ? RESEARCH
    : [
        ...RESEARCH,
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
    st.page = { k: "stats", view: "acquisition", reveal: 1, select: 0 };
  }

  // Open the document — long enough to see the blank page it was abandoned on.
  applySwitch(frame, st, beat.switchToEditor5, "editor");
  applySwitch(frame, st, beat.switchToBrowser5, "browser");

  // Back in the browser, a new question rather than the old page.
  if (frame >= beat.newResearchTab) {
    const loaded = frame >= beat.researchLoad;
    st.tabs.push(loaded ? { ...TAB.research } : { ...TAB.newtab });
    st.activeId = loaded ? "research" : "newtab";
    if (loaded) {
      st.url = URL.research;
      // The scroll has to finish inside S6; +8 collided with s7WrapUp.from after the
      // retime, and interpolate() throws on a zero-width input range.
      st.page = {
        k: "news",
        variant: 1,
        scroll: range(frame, [beat.researchLoad + 2, scene.s7WrapUp.from], [0, RESEARCH_SCROLL]),
        select: 0,
      };
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
  st.tabs = [{ ...TAB.search }, { ...TAB.news }, { ...TAB.stats }, { ...TAB.cohorts }, { ...TAB.research }];
  st.activeId = "research";
  st.url = URL.research;
  st.page = { k: "news", variant: 1, scroll: RESEARCH_SCROLL, select: 0 };
  st.dot = "none";

  st.toast = praiseToast(frame);

  applySwitch(frame, st, beat.switchToEditor6, "editor");
  applySwitch(frame, st, beat.switchToBrowser6, "browser");
  if (frame < SWITCH_AT(beat.switchToBrowser6)) return;

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
  // The popup is a child of the page viewport, so POPUP.top is measured from y=122.
  goalInput: { x: 930, y: 301 },
  startBtn: { x: 930, y: 417 },
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
  /** Result rows on the search page — title lines, measured off the render. */
  searchResult: [
    { x: 250, y: 295 },
    { x: 250, y: 405 },
    { x: 250, y: 515 },
  ],
  /** Roughly the middle of the article column, for reading scrolls. */
  read: { x: 600, y: 470 },
} as const;

/** Nudges the pointer a few px so parked stretches do not look frozen. */
const idle = (frame: number, x: number, y: number): Waypoint => ({ frame, x, y });

/**
 * When the pointer comes back after a Cmd-Tab: a few frames past the switch, but never
 * past whatever it has to be somewhere else for. CURSOR_PATH has to stay in ascending
 * frame order, and a fixed `+5` inverts the moment a retime pulls the next beat closer.
 */
const reappear = (afterSwitch: number, before: number): number =>
  Math.min(afterSwitch + 5, before - 5);

export const CURSOR_PATH: readonly Waypoint[] = [
  /* ---------------------------------------------------------------- S1 (0–60)
   * Opens with the pointer parked mid-screen on the new-tab page. The first movement in
   * the film is the crossing to the Kibitzer icon.
   */
  { frame: 0, x: 576, y: 432 },
  { frame: 5, x: 576, y: 432 },
  { frame: 12, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen, x: EXT.x, y: EXT.y, click: true },
  { frame: 19, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 20, x: HIT.goalInput.x, y: HIT.goalInput.y, click: true },
  { frame: beat.goalTypeEnd, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 47, x: HIT.startBtn.x, y: HIT.startBtn.y },
  { frame: beat.startClick, x: HIT.startBtn.x, y: HIT.startBtn.y, click: true },
  { frame: 58, x: 640, y: 430 },

  /* ---------------------------------------------------------------- S2 (60–270)
   * Three search-and-open cycles. Each one returns to the results tab, picks a different
   * row and opens it, so three distinct sources end up in the strip.
   */
  { frame: beat.searchEnter1 + 2, x: 300, y: 340 },
  { frame: beat.result1Click - 4, x: HIT.searchResult[0].x, y: HIT.searchResult[0].y },
  { frame: beat.result1Click, x: HIT.searchResult[0].x, y: HIT.searchResult[0].y, click: true },
  idle(beat.newsEnter + 6, HIT.read.x, HIT.read.y),
  { frame: beat.switchToEditor1 + 4, x: HIT.read.x, y: HIT.read.y, hidden: true },

  { frame: beat.switchToBrowser1 + 5, x: tabX(0, 2), y: TAB_Y, hidden: false },
  { frame: beat.searchEnter2, x: tabX(0, 2), y: TAB_Y, click: true },
  { frame: beat.result2Click - 3, x: HIT.searchResult[1].x, y: HIT.searchResult[1].y },
  { frame: beat.result2Click, x: HIT.searchResult[1].x, y: HIT.searchResult[1].y, click: true },
  // Drag-select the channel table, then copy.
  { frame: beat.select1, x: 676, y: 376 },
  { frame: beat.copy1, x: 1092, y: 488 },
  { frame: beat.switchToEditor2 + 4, x: 1092, y: 488, hidden: true },

  { frame: beat.switchToBrowser2 + 5, x: tabX(0, 3), y: TAB_Y, hidden: false },
  { frame: beat.searchEnter3, x: tabX(0, 3), y: TAB_Y, click: true },
  { frame: beat.result3Click - 2, x: HIT.searchResult[2].x, y: HIT.searchResult[2].y },
  { frame: beat.result3Click, x: HIT.searchResult[2].x, y: HIT.searchResult[2].y, click: true },
  { frame: beat.switchToEditor3 + 4, x: HIT.searchResult[2].x, y: HIT.searchResult[2].y, hidden: true },

  { frame: reappear(beat.switchToBrowser3, beat.newsReturn), x: tabX(1, 4), y: TAB_Y, hidden: false },
  { frame: beat.newsReturn, x: tabX(1, 4), y: TAB_Y, click: true },
  // The pull quote, selected and copied.
  { frame: beat.select2, x: 295, y: 288 },
  { frame: beat.copy2, x: 855, y: 322 },
  { frame: beat.switchToEditor4 + 4, x: 855, y: 322, hidden: true },

  /* ---------------------------------------------------------------- S3 (270–460) */
  { frame: beat.switchToBrowser4 + 5, x: 620, y: 300, hidden: false },
  { frame: beat.newTabClick - 4, x: newTabX(4), y: TAB_Y },
  { frame: beat.newTabClick, x: newTabX(4), y: TAB_Y, click: true },
  idle(beat.igEnter + 6, 660, 430),
  { frame: beat.igDmEnter - 5, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y },
  { frame: beat.igDmEnter, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y, click: true },
  { frame: beat.dmReply1 - 3, x: HIT.dmCompose.x, y: HIT.dmCompose.y },
  { frame: beat.dmReply1, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  { frame: beat.dmSwitch2 - 4, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y },
  { frame: beat.dmSwitch2, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y, click: true },
  { frame: beat.dmReply2, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  // Interrupted mid-reply: the third row lights up and wins.
  { frame: beat.dmSwitch3 - 4, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y },
  { frame: beat.dmSwitch3, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y, click: true },
  { frame: beat.musicOpen - 6, x: HIT.dmLink.x, y: HIT.dmLink.y },
  { frame: beat.musicOpen, x: HIT.dmLink.x, y: HIT.dmLink.y, click: true },
  idle(beat.musicOpen + 10, 640, 470),
  { frame: beat.dmReturn - 5, x: tabX(4, 6), y: TAB_Y },
  { frame: beat.dmReturn, x: tabX(4, 6), y: TAB_Y, click: true },
  idle(beat.dmReturn + 12, 820, 700),
  { frame: beat.nudge1Dismiss - 8, x: HIT.toastClose.x, y: HIT.toastClose.y },
  { frame: beat.nudge1Dismiss, x: HIT.toastClose.x, y: HIT.toastClose.y, click: true },
  idle(beat.nudge1Dismiss + 10, 820, 700),

  /* ---------------------------------------------------------------- S4 (460–645) */
  { frame: beat.snoozeClick - 10, x: HIT.toastBreak.x, y: HIT.toastBreak.y },
  { frame: beat.snoozeClick, x: HIT.toastBreak.x, y: HIT.toastBreak.y, click: true },
  { frame: beat.portalEnter - 3, x: newTabX(6), y: TAB_Y },
  { frame: beat.portalEnter, x: newTabX(6), y: TAB_Y, click: true },
  { frame: beat.shopEnter - 8, x: HIT.portalAd.x, y: HIT.portalAd.y },
  { frame: beat.shopEnter - 2, x: HIT.portalAd.x, y: HIT.portalAd.y, click: true },
  { frame: beat.shopEnter + 3, x: 640, y: 500 },
  { frame: beat.shopPick - 7, x: HIT.shopCard.x, y: HIT.shopCard.y },
  { frame: beat.shopPick, x: HIT.shopCard.x, y: HIT.shopCard.y, click: true },
  // Parked on the add-to-cart button through the spree — the badge does the talking.
  { frame: beat.cart1, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart2, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek1 - 3, x: tabX(4, 8), y: TAB_Y },
  { frame: beat.dmPeek1, x: tabX(4, 8), y: TAB_Y, click: true },
  idle(beat.dmPeek1 + 8, 700, 620),
  { frame: beat.dmPeek1End - 3, x: tabX(7, 8), y: TAB_Y },
  { frame: beat.dmPeek1End, x: tabX(7, 8), y: TAB_Y, click: true },
  { frame: beat.cart3, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart4, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart5, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek2 - 3, x: tabX(4, 8), y: TAB_Y },
  { frame: beat.dmPeek2, x: tabX(4, 8), y: TAB_Y, click: true },
  idle(beat.dmPeek2 + 7, 700, 620),
  { frame: beat.dmPeek2End - 3, x: tabX(7, 8), y: TAB_Y },
  { frame: beat.dmPeek2End, x: tabX(7, 8), y: TAB_Y, click: true },
  { frame: beat.cart6, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cart7, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cartViewEnter, x: HIT.shopCart.x, y: HIT.shopCart.y, click: true },
  { frame: beat.cartViewEnter + 10, x: 700, y: 430 },
  // Dead still across the freeze — any drift undercuts the pause.
  { frame: beat.freezeEnd, x: 700, y: 430 },

  /* ---------------------------------------------------------------- S6 (690–770) */
  { frame: beat.closeTab1 - 5, x: tabCloseX(7, 8), y: TAB_Y },
  { frame: beat.closeTab1, x: tabCloseX(7, 8), y: TAB_Y, click: true },
  { frame: beat.closeTab2, x: tabCloseX(6, 8), y: TAB_Y, click: true },
  { frame: beat.closeTab3, x: tabCloseX(5, 8), y: TAB_Y, click: true },
  { frame: beat.closeTab4, x: tabCloseX(4, 8), y: TAB_Y, click: true },
  // No click needed — closing the last stray tab already lands on a goal-related one.
  { frame: beat.returnToGoalTab, x: tabX(1, 4), y: TAB_Y },
  { frame: beat.switchToEditor5 + 4, x: 600, y: 430, hidden: true },
  { frame: reappear(beat.switchToBrowser5, beat.newResearchTab), x: 620, y: 300, hidden: false },
  { frame: beat.newResearchTab - 4, x: newTabX(4), y: TAB_Y },
  { frame: beat.newResearchTab, x: newTabX(4), y: TAB_Y, click: true },
  idle(beat.researchLoad + 6, HIT.read.x, HIT.read.y),

  /* ---------------------------------------------------------------- S7 (770–900) */
  { frame: beat.switchToEditor6 + 4, x: HIT.read.x, y: HIT.read.y, hidden: true },
  { frame: reappear(beat.switchToBrowser6, beat.mailOpen), x: 620, y: 300, hidden: false },
  { frame: beat.mailOpen - 4, x: newTabX(5), y: TAB_Y },
  { frame: beat.mailOpen, x: newTabX(5), y: TAB_Y, click: true },
  { frame: beat.sendClick - 7, x: HIT.mailSend.x, y: HIT.mailSend.y },
  { frame: beat.sendClick, x: HIT.mailSend.x, y: HIT.mailSend.y, click: true },
  { frame: beat.popupOpen2 - 4, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen2, x: EXT.x, y: EXT.y, click: true },
  { frame: beat.endSessionClick - 5, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
  { frame: beat.endSessionClick, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y, click: true },
  { frame: beat.endCardIn - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
];

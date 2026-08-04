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
  dotForGauge,
} from "../theme";
import {
  DocBlock,
  GOAL,
  GOAL_BUDGET_LABEL,
  nudge,
  omniSocial,
  popupLines,
  summary as summaryCopy,
  praise,
  report,
  researchQuery,
  tabs as tabTitles,
} from "../copy";
import { SWITCHER_FRAMES, beat, clockAt, driveAt, scene } from "../timeline";
import { between, progress, range, toastEase } from "../lib/anim";
import { typed, typedEnd } from "../lib/typewriter";
import { KeyPress, SfxCue, TypingRun, clickCues, keyboardCues, mergeInput } from "../lib/inputsfx";
import { layout, scrollFor } from "../lib/doclayout";
import { Waypoint } from "../lib/cursor";
import { OmniState, TabSpec, tabBaseWidth, tabCloseX } from "../components/browser/BrowserWindow";
import { PopupState } from "../components/extension/ExtensionPopup";
import { HotButton } from "../components/toast/Toast";
import { AppKey } from "../components/desktop/AppSwitcher";
import { KeyHintState } from "../components/KeyHint";
import { SEARCHES } from "../components/sites/SearchMock";
import { CHATS } from "../components/sites/InstagramMock";
import { PRODUCTS } from "../components/sites/ShopMock";

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
      view: "list" | "detail" | "results" | "cart";
      listScroll: number;
      /** Grid card about to be clicked — an index into the grid on screen, not into PRODUCTS. */
      listHot: number | null;
      /** Product order behind the search results grid. */
      results: number[];
      /** What is in the mall's own search box, and whether the caret is in it. */
      query: string;
      searchFocus: boolean;
      product: number;
      cart: number;
      cartPulse: number;
      cartItems: number[];
      addHot: boolean;
      /** The 함께 본 상품 rail, and which of its rows is about to be clicked. */
      rec: number[];
      recHot: number | null;
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
  /** Toolbar Back, lit while it is being pressed; Forward, enabled once there is a page to go back to. */
  backHot: boolean;
  forwardOn: boolean;
  zoom: number;
};

/* ------------------------------------------------------------------ the gauge */

/**
 * S, the 0–100 focus gauge, as a function of frame.
 *
 * This is the spine of the piece, so it is written once here and everything else reads
 * it: the toolbar badge takes its colour from the band (theme.badgeForGauge), and the
 * popup prints the number outright. The shape is dictated by the shipping reducer in
 * apps/extension-next/src/core/gauge/reducer.ts, not chosen for looks:
 *
 *   · S starts at 100 (initGaugeState) and holds there while the work is on goal —
 *     recovery is capped, so on-goal time cannot bank credit.
 *   · Drift drains it. The FIRST nudge fires on the downward crossing into ZERO, not at
 *     some streak count, which is why S has to be spent by nudge1In rather than at it.
 *   · It stays at 0 for the rest of the drift; nudges 2 and 3 are scheduled by renagDebt
 *     (rRenag 40, doubling per nag), which keeps accruing even while snoozed — that is
 *     what makes the third nudge land the moment the 5-minute break expires.
 *   · Coming back refills it, and the celebration fires crossing cCelebrate = 80, so the
 *     praise toast at praiseIn is pinned to that crossing.
 *
 * Frames between keypoints interpolate linearly, which is what a constant rDrain/rRecover
 * looks like.
 */
const GAUGE: ReadonlyArray<readonly [frame: number, s: number]> = [
  [beat.startClick, 100],
  [beat.newTabClick, 100],
  // 100 → 0 across the messages drift; passes 66 near the social landing and 33 near the
  // point the thread takes over completely.
  [beat.nudge1In - 2, 0],
  [beat.returnToGoalTab, 0],
  [beat.praiseIn, 80],
  [beat.praiseIn + 16, 100],
];

export const gaugeAt = (frame: number): number => {
  if (frame <= GAUGE[0][0]) return GAUGE[0][1];
  for (let i = 1; i < GAUGE.length; i += 1) {
    const [f1, s1] = GAUGE[i];
    if (frame <= f1) {
      const [f0, s0] = GAUGE[i - 1];
      return f1 === f0 ? s1 : s0 + ((s1 - s0) * (frame - f0)) / (f1 - f0);
    }
  }
  return GAUGE[GAUGE.length - 1][1];
};

/** The 5-minute break taken off nudge #2 — a live snooze outranks every colour band. */
const snoozedAt = (frame: number): boolean => between(frame, beat.snoozeClick, beat.nudge3In);

/** No goal declared yet means no dot at all, not a neutral one (clearBadge). */
const dotAt = (frame: number): DotKind =>
  frame < beat.startClick ? "none" : dotForGauge(gaugeAt(frame), snoozedAt(frame));

/**
 * Share of the declared time budget spent, which is what the sundial draws.
 *
 * The film's clock runs 2:00 → 3:55 against a 120-minute budget, so the sprout's shadow
 * swings almost exactly one traversal across the piece and never reaches the moon.
 */
const elapsedAt = (frame: number): number =>
  Math.max(0, Math.min(1, (frame - beat.startClick) / (beat.popupOpen2 - beat.startClick)));

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
  shopSearch: "shop.daylight.co.kr/search?q=",
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
 *   211–242   §1 body, §2.1–2.4       (clock 2:13 → 2:33)
 *   269–291   §3.1, and the §3.2 head  (clock 2:36 → 2:42)
 *   304–320   §3.2 tail, [자료 2], §3.3
 *   1000–1051  §3.4, §4                 (clock 3:31 → 3:38, after the return)
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

/*
 * Typing rates that are not derived from a gap, named because the keystroke cues at the
 * bottom of this file have to reproduce them exactly. A literal in two places is a
 * literal that will eventually disagree with itself.
 *
 * The two searches run at a rate no hand could reach, and are meant to: an address bar
 * with four words already in it is autocomplete, not typing, and the film has no time to
 * pretend otherwise. The goal and the mall query are the ones you watch being written.
 */
const GOAL_RATE = 1.55;
const SEARCH_RATE = 0.16;
const SEARCH_LEAD = 6;
const RESEARCH_RATE = 0.4;
const PORTAL_QUERY = "러닝화 추천";
const PORTAL_RATE = 1.1;

/* ------------------------------------------------------------------ S1 — goal declaration */

const s1 = (frame: number, st: Stage): void => {
  st.tabs = [{ ...TAB.newtab }];
  st.activeId = "newtab";
  st.url = URL.newtab;
  st.page = { k: "newtab" };

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
            goal: typed(GOAL, frame, beat.goalTypeStart, GOAL_RATE),
            // The budget is a select now, so it reads its default from the first frame —
            // there is nothing to type and the pointer never goes near it.
            duration: GOAL_BUDGET_LABEL,
            // Nothing has ever been declared on this profile, so the setup view leads
            // with the specificity hint and the three example chips.
            firstRun: true,
            typingGoal: between(frame, beat.goalTypeStart - 4, beat.startClick),
            startPressed: between(frame, beat.startClick, beat.startClick + 5),
          }
        : {
            // A fresh session opens at a full gauge — initGaugeState puts S at 100 and
            // nothing has been judged yet. The sundial is at first light.
            kind: "active",
            s: Math.round(gaugeAt(frame)),
            goal: GOAL,
            elapsed: elapsedAt(frame),
            judgeOn: true,
            persona: popupLines.persona,
          },
  };
};

/* ------------------------------------------------------------------ S2 — the research loop */

/**
 * Four round trips between the browser and the writing app, across three source tabs.
 *
 * Paced as a parabola. Trip 1 reads at a speed you can follow — twelve frames on the
 * results page and twenty on the article, which is the landing; trips 2–4 tighten until
 * the cohorts page is on screen for eleven frames, which is exactly what the middle of a
 * long working stretch feels like from the outside. Then it comes back down: the last
 * paragraph is typed four times slower than the ones before it, two Enters, and six
 * tenths of a second with nothing on screen but a caret.
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
  query: typed(SEARCHES[c.set].query, frame, c.searchAt - SEARCH_LEAD, SEARCH_RATE),
  hot: frame >= c.clickAt - 5 ? SEARCHES[c.set].pick : null,
});

const s2 = (frame: number, st: Stage): void => {
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

/**
 * The message logs, flattened to what the schedule needs: direction, text, length.
 *
 * Character counts are precomputed because the compose box derives its typing rate from
 * them on every frame, and the words themselves stay where they belong — with the
 * component that draws the bubbles.
 */
const DM_LOGS = CHATS.map((log) =>
  log.map((m) => ({ out: m.out, text: m.text ?? "", chars: Array.from(m.text ?? "").length })),
);

/** Unread count and list state keep climbing whether or not the tab is on screen. */
const dmBadge = (frame: number): number => Math.min(28, 3 + Math.floor((frame - beat.igDmEnter) / 14));
const dmUnread = (frame: number): number => Math.min(8, 1 + Math.floor((frame - beat.igDmEnter) / 48));

/**
 * The messages, as a schedule of FIXED windows.
 *
 * Every segment declares the frames it owns and how many messages it has to deliver in
 * them; the rate falls out of the division. That is the whole point of writing it this
 * way — adding four lines to a thread makes the thread faster, never longer, so the film
 * cannot be re-paced by editing chat copy. It is the same contract `rateFor` gives the
 * document.
 *
 * The segments are also two different KINDS of conversation, because that is what an
 * afternoon actually looks like:
 *
 *   민아 (thread 0) is the friend. She opens the drift, she is still going when the tab
 *   is somewhere else, and the film comes back to her three times — first, after the
 *   player, and again mid-spree. Her log runs both ways.
 *
 *   준호 (1), 다영 (2) and the study group (3) are errands. Each opens on a pile that has
 *   clearly been sitting there, gets read at a glance, gets one reply, and is left.
 *
 * The first segment is a hold, not a run: `first === last`, so the thread that just opened
 * sits perfectly still for half a second. That is the 0.7× landing.
 */
type DmSegment = {
  from: number;
  /** The frame the segment's last message lands on. Its length is fixed; its rate is not. */
  to: number;
  thread: number;
  /** Messages already on screen when the segment opens. */
  first: number;
  /** Messages on screen when it ends. */
  last: number;
};

const dmSegments: readonly DmSegment[] = [
  { from: beat.igDmEnter, to: beat.dmRun1, thread: 0, first: 3, last: 3 },
  { from: beat.dmRun1, to: beat.dmSwitch2, thread: 0, first: 3, last: 10 },
  { from: beat.dmSwitch2, to: beat.dmSwitch3, thread: 1, first: 4, last: 6 },
  // The link is message 4 and lands a beat after this thread opens — it has to arrive on
  // screen, not already be sitting there.
  { from: beat.dmSwitch3, to: beat.musicOpen, thread: 2, first: 2, last: 5 },
  // Back from the player: she kept going without you.
  { from: beat.dmReturn, to: beat.nudge1In + 20, thread: 0, first: 11, last: 14 },
  // The two trips back mid-spree — the long thread, then a pile.
  { from: beat.dmPeek1, to: beat.dmPeek1End, thread: 0, first: 15, last: 18 },
  { from: beat.dmPeek2, to: beat.dmPeek2End, thread: 3, first: 5, last: 7 },
];

const dmPage = (frame: number): PageKind => {
  let seg = dmSegments[0];
  for (const s of dmSegments) if (frame >= s.from) seg = s;

  const step = (seg.to - seg.from) / Math.max(1, seg.last - seg.first);
  const msgs = Math.min(seg.last, seg.first + Math.max(0, Math.floor((frame - seg.from) / step)));

  /*
   * The compose box types whatever the next outgoing message is, finishing exactly as that
   * message lands. Deriving it means the reply in the box is always the bubble that
   * appears next — the old fixed strings drifted out of sync with the log the moment
   * either one was edited.
   */
  const log = DM_LOGS[seg.thread] ?? [];
  const nextOut = log.findIndex((m, i) => i >= msgs && m.out);
  let composing = "";
  if (nextOut >= 0 && nextOut < seg.last) {
    const lands = seg.from + (nextOut - seg.first + 1) * step;
    if (frame < lands) composing = typed(log[nextOut].text, frame, lands - step, step / Math.max(1, log[nextOut].chars));
  }

  // Dots for the back half of each wait, so they read as "…and here it comes" rather than
  // as a decoration that is simply always on.
  const sinceLast = (frame - seg.from) % step;
  const nextIsIn = msgs < log.length && !log[msgs].out;

  return {
    k: "igDm",
    thread: seg.thread,
    messages: msgs,
    typing: msgs < seg.last && !composing && nextIsIn && sinceLast > step * 0.5,
    badge: dmBadge(frame),
    unreadRows: dmUnread(frame),
    // The row that lights up mid-reply, right before it steals the cursor.
    flashThread: between(frame, beat.dmInterrupt, beat.dmSwitch3) ? 2 : null,
    composing,
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


  st.toast = nudgeToast(frame, nudge.first, beat.nudge1In, beat.nudge1Dismiss, {
    closeHot: between(frame, beat.nudge1Dismiss - 6, beat.nudge1Dismiss + 2),
  });
};

/* ------------------------------------------------------------------ S4 — drift #2/#3: the mall */

/**
 * The mall, as a browsing session.
 *
 * The old cut was a loop: 장바구니, rail row, 장바구니, rail row, seven times over. It is
 * the right MECHANISM — a mall keeps somebody by putting the next thing beside the thing
 * they just took, which is the mechanism the neglected report is literally about — but run
 * seven times unbroken it stops reading as a person and starts reading as a macro: one
 * button and one row, alternating, on a page that barely changes between them.
 *
 * So the same window now carries the four ways somebody actually moves through a shop, and
 * no two consecutive items arrive the same way:
 *
 *   `shopPick`      off the listing grid, after the landing scroll
 *   `hop1` `hop2`   the 함께 본 상품 rail — the mall's own suggestion
 *   `backClick`     the browser's Back button, onto the product page from two stops ago —
 *                   the one page the history actually holds — and out of it again down a
 *                   different rail row (`hop3`)
 *   `shopSearch`    the mall's own search box: 캠핑 의자 typed into it, results, a card
 *   `hop4`          the rail once more, to close it out
 *
 * MALL is that session written as an ordered list of PAGES, each carrying how it was
 * reached, because "how it was reached" is what decides what lights up before the click:
 * a rail row, a grid card, or nothing at all. Everything else in the scene — the cart
 * contents, the badge, the rail contents, the URL — is derived from this list, so the
 * pointer cannot end up clicking something the page is not showing.
 */
const SHOP_QUERY = "캠핑 의자";
const SHOP_QUERY_RATE = 1.2;
/** What the mall puts up for that query: the thing searched for, then its usual neighbours. */
const SHOP_RESULTS = [2, 3, 9, 6, 7] as const;

type MallPage = {
  /** Frame the page appears — i.e. the frame the click that opened it lands on. */
  at: number;
  /** How it was reached. `card` indexes the grid on screen, `row` the three rail rows. */
  via: "portal" | "card" | "rail" | "back" | "search" | "result" | "cart";
  view: "list" | "detail" | "results" | "cart";
  product?: number;
  row?: number;
  card?: number;
};

const MALL: readonly MallPage[] = [
  { at: beat.shopEnter, via: "portal", view: "list" },
  { at: beat.shopPick, via: "card", view: "detail", product: 0, card: 0 },
  { at: beat.hop1, via: "rail", view: "detail", product: 5, row: 0 },
  { at: beat.hop2, via: "rail", view: "detail", product: 1, row: 2 },
  // Back. Not to the listing — to the page that was on screen two stops ago, which is what
  // a browser's history actually holds and the only thing this button is allowed to do.
  { at: beat.backClick, via: "back", view: "detail", product: 5 },
  { at: beat.hop3, via: "rail", view: "detail", product: 8, row: 1 },
  { at: beat.searchResults, via: "search", view: "results" },
  { at: beat.searchPick, via: "result", view: "detail", product: 2, card: 0 },
  { at: beat.hop4, via: "rail", view: "detail", product: 4, row: 2 },
  { at: beat.cartViewEnter, via: "cart", view: "cart" },
];

const CART_STEPS = [beat.cart1, beat.cart2, beat.cart3, beat.cart4, beat.cart5, beat.cart6] as const;

/**
 * What ends up in the cart: whatever product page was on screen at each 담기, in order.
 * Derived rather than listed, so the cart cannot disagree with what was clicked.
 */
const CART_ITEMS: readonly number[] = CART_STEPS.map((at) => {
  let product = 0;
  for (const p of MALL) if (p.at <= at && p.view === "detail") product = p.product ?? product;
  return product;
});

/** Rows drawn by RecRail in ShopMock, and hit points HIT.shopRec in the cursor path. */
const REC_RAIL_ROWS = 3;

/**
 * Three rail rows, filled from the product on screen and then overwritten at the row the
 * next hop will click. The fillers only have to look plausible; the hot row has to be the
 * product the cursor is about to open, or the click lies about what it did.
 */
const railFor = (product: number, next: number | null, row: number): number[] => {
  const rail: number[] = [];
  for (let k = 1; rail.length < REC_RAIL_ROWS; k += 1) {
    const idx = (product + k * 4) % PRODUCTS.length;
    if (idx !== product && idx !== next && !rail.includes(idx)) rail.push(idx);
  }
  if (next !== null) rail[row] = next;
  return rail;
};

/** The mall at `frame`: which page, what is in the cart, and what is about to be clicked. */
const mallAt = (frame: number) => {
  let i = 0;
  for (let k = 0; k < MALL.length; k += 1) if (frame >= MALL[k].at) i = k;
  const page = MALL[i];
  const next = i + 1 < MALL.length ? MALL[i + 1] : null;

  let added = 0;
  for (const at of CART_STEPS) if (frame >= at) added += 1;
  const lastAdd = added > 0 ? CART_STEPS[added - 1] : -999;
  const nextAdd = added < CART_STEPS.length ? CART_STEPS[added] : Infinity;

  // Whatever opens the NEXT page is what has to light up before it is clicked.
  const rail = next && next.via === "rail" ? next : null;
  const card = next && (next.via === "card" || next.via === "result") ? next : null;
  const product = page.product ?? 0;

  return {
    view: page.view,
    product,
    count: added,
    items: CART_ITEMS.slice(0, added),
    pulse: range(frame, [lastAdd, lastAdd + 8], [1, 0], Easing.out(Easing.quad)),
    addHot: page.view === "detail" && frame >= nextAdd - 5 && frame < nextAdd + 2,
    rec: page.view === "detail" ? railFor(product, rail?.product ?? null, rail?.row ?? 0) : [],
    recHot: rail && frame >= rail.at - 6 && frame < rail.at + 2 ? (rail.row ?? 0) : null,
    cardHot: card && frame >= card.at - 8 && frame < card.at + 2 ? (card.card ?? 0) : null,
  };
};

/**
 * The cart as it stands after the last 담기 — the page the freeze holds on and the one the
 * cleanup closes. Written once because S4, S5 and S6 all have to show the same six items.
 */
const CART_PAGE: PageKind = {
  k: "shop",
  view: "cart",
  listScroll: 0,
  listHot: null,
  results: [...SHOP_RESULTS],
  query: SHOP_QUERY,
  searchFocus: false,
  product: CART_ITEMS[CART_ITEMS.length - 1],
  cart: CART_ITEMS.length,
  cartPulse: 0,
  cartItems: [...CART_ITEMS],
  addHot: false,
  rec: [],
  recHot: null,
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
  // The messages carry on for a moment before the portal; no toast is up yet.
  if (frame < beat.portalEnter) return;

  /*
   * A search on the portal turns into a session. The cart badge is the clock — 0 → 6 says
   * "time passed" more concretely than any scroll, and it is the payoff of the report's
   * own subject matter. The two trips back to the messages are what make the badge jump:
   * you look away, and both counters have moved.
   *
   * The listing grid gets the twenty frames after `shopEnter`: it exists to say "this is a
   * shopping site" before anything is clicked, because the spree means nothing if the
   * audience is still working out what page it is on. Unlike the old cut it is not the only
   * page of its kind — the search puts a second grid up two thirds of the way through, and
   * the two are what keep the middle of the scene from looking like one screen.
   */
  st.tabs.push({ ...TAB.portal });
  if (frame < beat.shopEnter) {
    st.activeId = "portal";
    st.url = URL.portal;
    st.page = {
      k: "portal",
      query: typed(PORTAL_QUERY, frame, beat.portalQuery, PORTAL_RATE),
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
    const mall = mallAt(frame);
    st.activeId = "shop";
    st.url =
      mall.view === "cart"
        ? URL.shopCart
        : mall.view === "list"
          ? URL.shopList
          : mall.view === "results"
            ? // Chrome shows the decoded query in the omnibox, not the percent-escaped one.
              `${URL.shopSearch}${SHOP_QUERY}`
            : `shop.daylight.co.kr/products/${PRODUCTS[mall.product].slug}`;
    st.page = {
      k: "shop",
      view: mall.view,
      // A long, readable scroll: this is the landing, and the grid earns its twenty frames.
      listScroll: mall.view === "list" ? range(frame, [beat.shopEnter + 3, beat.shopPick - 4], [0, 96], Easing.linear) : 0,
      listHot: mall.cardHot,
      results: [...SHOP_RESULTS],
      // The query stays in the box once it has been submitted, the way a real one does.
      query: frame < beat.shopSearch ? "" : typed(SHOP_QUERY, frame, beat.shopSearch + 1, SHOP_QUERY_RATE),
      searchFocus: between(frame, beat.shopSearch, beat.searchResults),
      product: mall.product,
      cart: mall.count,
      cartPulse: mall.view === "cart" ? 0 : mall.pulse,
      cartItems: [...mall.items],
      addHot: mall.addHot,
      rec: mall.rec,
      recHot: mall.recHot,
    };
    // Back is pressed once, and Forward stays live until the next click writes over it.
    st.backHot = between(frame, beat.backClick - 4, beat.backClick + 4);
    st.forwardOn = between(frame, beat.backClick, beat.hop3);
  }

  /*
   * Nudge #2, on the product page rather than on the messages — the cart is at two and
   * still climbing, so the toast can point at the thing it is actually about. The spree
   * stops dead while it is up and resumes on the snooze.
   */
  st.toast = nudgeToast(frame, nudge.second, beat.nudge2In, beat.snoozeClick, {
    hotButton: between(frame, beat.snoozeClick - 8, beat.snoozeClick + 3) ? "break" : null,
  });

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
  st.page = CART_PAGE;

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
    st.page = CART_PAGE;
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
      st.omni = {
        typed: typed(researchQuery, frame, beat.newResearchTab + 2, RESEARCH_RATE),
        completion: "",
        suggestion: null,
      };
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

  /*
   * The closing look at the popup: the bar back at the top, then 종료하기 opens the
   * session summary — the one screen that reports on the whole two hours.
   */
  if (frame >= beat.popupOpen2) {
    st.popup = {
      reveal: progress(frame, beat.popupOpen2, 8),
      state:
        frame >= beat.summaryShown
          ? { kind: "summary", summary: summaryCopy }
          : {
              kind: "active",
              s: Math.round(gaugeAt(frame)),
              goal: GOAL,
              elapsed: elapsedAt(frame),
              judgeOn: true,
              persona: popupLines.persona,
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
    dot: dotAt(frame),
    page: { k: "newtab" },
    popup: null,
    toast: null,
    keyHint: null,
    backHot: false,
    forwardOn: false,
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
  /*
   * The popup is 296 wide and pinned to a fixed right edge, so it spans x 794–1090 with a
   * 14px pad. The goal field shares its row with the fixed 82px 시간(분) column, which is
   * why it centres left of the button below it rather than under it.
   */
  goalInput: { x: 897, y: 418 },
  startBtn: { x: 942, y: 466 },
  /** 종료하기 — the rightmost of the three flex:1 buttons in the active view's row. */
  endSessionBtn: { x: 1034, y: 521 },
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
  /**
   * Columns of the mall's 5-up grid. 1060px of content inside a 24px pad, four 13px gutters:
   * a column is 201.6 wide and the k-th centre is 146.8 + 214.6k. `shopCard` is the listing,
   * which is scrolled 96px by the time anything is picked; `shopResult` is the same row on
   * the search results, which is not scrolled at all — hence the 96px between them.
   */
  shopCard: [
    { x: 147, y: 330 },
    { x: 361, y: 330 },
    { x: 576, y: 330 },
    { x: 791, y: 330 },
    { x: 1005, y: 330 },
  ],
  shopResult: [
    { x: 147, y: 426 },
    { x: 361, y: 426 },
    { x: 576, y: 426 },
    { x: 791, y: 426 },
    { x: 1005, y: 426 },
  ],
  /** "장바구니" button on a product page, and the cart icon in the mall header. */
  shopAdd: { x: 455, y: 468 },
  shopCart: { x: 1096, y: 147 },
  /** The mall's own search box: 420 wide, after the 26px mark and an 18px gap. */
  shopSearch: { x: 300, y: 147 },
  /** Toolbar Back — 8px of padding plus half of a 26px button, on the toolbar's centre line. */
  navBack: { x: WINDOW.x + 21, y: WINDOW.y + TABSTRIP_H + TOOLBAR_H / 2 },
  /**
   * The three 함께 본 상품 rows, which is where every hop after the first one is clicked.
   * Derived from RecRail's own geometry: the rail is 236 wide against the window's right
   * edge, its rows are 84 tall on a 10px gap, and the first one starts under a 22px pad
   * plus the section title. Check with `node scripts/render-stills.mjs s4-shop-rec`.
   */
  shopRec: [
    { x: 1012, y: 288 },
    { x: 1012, y: 382 },
    { x: 1012, y: 476 },
  ],
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
 * Where a mall click lands, read out of MALL rather than repeated here.
 *
 * The pointer and the page are the two halves of the same lie, and the way that lie used to
 * break was a retime moving one of them: a hop whose rail row had been re-ordered, a card
 * index that no longer matched the grid. Taking the coordinate from the page's own `row` /
 * `card` means the pointer cannot click a row the page is not lighting up.
 */
const mallHit = (at: number) => {
  const page = MALL.find((p) => p.at === at);
  if (!page) throw new Error(`no mall page at ${at}`);
  if (page.via === "rail") return HIT.shopRec[page.row ?? 0];
  if (page.via === "card") return HIT.shopCard[page.card ?? 0];
  if (page.via === "result") return HIT.shopResult[page.card ?? 0];
  if (page.via === "back") return HIT.navBack;
  return HIT.shopCart;
};

/**
 * When the pointer comes back after a Cmd-Tab: a few frames past the switch, but never
 * past whatever it has to be somewhere else for, and never before the switch itself.
 * CURSOR_PATH has to stay in ascending frame order, and a fixed `+5` inverts the moment a
 * retime pulls the next beat closer — while the `before - 5` that fixes that can hand back
 * a frame at which the browser is still behind the writing app, and the pointer would
 * reappear on a window it is not pointing at.
 */
const reappear = (afterSwitch: number, before: number): number =>
  Math.max(afterSwitch + 2, Math.min(afterSwitch + 5, before - 5));

/**
 * The pointer, as an ordered list of arrivals.
 *
 * Every frame here is when the cursor GETS somewhere, not when it sets off: `cursorAt`
 * schedules the crossing backwards from the arrival at a speed set by the distance, so a
 * waypoint five frames before a click is a hand settling on a button, not a hand that has
 * been drifting towards it for the whole cut. That is what lets the same list survive a
 * retime — stretching a beat lengthens the pause, not the reach.
 */
export const CURSOR_PATH: readonly Waypoint[] = [
  /* ---------------------------------------------------------------- S1 (0–144)
   * Opens with the pointer parked mid-screen on the new-tab page. The first movement in
   * the film is the crossing to the Kibitzer icon.
   */
  { frame: 0, x: 576, y: 432 },
  { frame: 6, x: 576, y: 432 },
  { frame: 13, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen, x: EXT.x, y: EXT.y, click: true },
  // The popup is READ before it is typed into: 18 frames of hint and example chips with the
  // pointer sitting still on the icon it just clicked, which is what people actually do.
  { frame: 34, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 36, x: HIT.goalInput.x, y: HIT.goalInput.y, click: true },
  { frame: beat.goalTypeEnd, x: HIT.goalInput.x, y: HIT.goalInput.y },
  { frame: 94, x: HIT.startBtn.x, y: HIT.startBtn.y },
  { frame: beat.startClick, x: HIT.startBtn.x, y: HIT.startBtn.y, click: true },
  // And read once more: the active view holds for 40 frames after the click, so the hand
  // comes off the button and waits with it rather than cutting away.
  idle(beat.startClick + 14, 730, 512),
  { frame: beat.popupClose + 4, x: 640, y: 430 },

  /* ---------------------------------------------------------------- S2 (144–411)
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

  /* ---------------------------------------------------------------- S3 (411–643)
   * Two landings before the run: the feed is browsed for a full second before the messages
   * are opened, and the thread that opens is looked at before anything is typed into it.
   */
  { frame: beat.switchToBrowser4 + 5, x: 620, y: 300, hidden: false },
  { frame: beat.newTabClick - 4, x: newTabX(4), y: TAB_Y },
  { frame: beat.newTabClick, x: newTabX(4), y: TAB_Y, click: true },
  idle(beat.igEnter + 7, 660, 430),
  idle(beat.igEnter + 17, 700, 560),
  { frame: beat.igDmEnter - 5, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y },
  { frame: beat.igDmEnter, x: HIT.igDmIcon.x, y: HIT.igDmIcon.y, click: true },
  idle(beat.dmRun1 + 4, 700, 560),
  { frame: beat.dmReply1 - 4, x: HIT.dmCompose.x, y: HIT.dmCompose.y },
  { frame: beat.dmReply1, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  { frame: beat.dmSwitch2 - 5, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y },
  { frame: beat.dmSwitch2, x: HIT.dmRow[1].x, y: HIT.dmRow[1].y, click: true },
  { frame: beat.dmReply2, x: HIT.dmCompose.x, y: HIT.dmCompose.y, click: true },
  // Interrupted mid-reply: the third row lights up and wins.
  { frame: beat.dmSwitch3 - 4, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y },
  { frame: beat.dmSwitch3, x: HIT.dmRow[2].x, y: HIT.dmRow[2].y, click: true },
  { frame: beat.musicOpen - 6, x: HIT.dmLink.x, y: HIT.dmLink.y },
  { frame: beat.musicOpen, x: HIT.dmLink.x, y: HIT.dmLink.y, click: true },
  idle(beat.musicOpen + 8, 640, 470),
  { frame: beat.dmReturn - 4, x: tabX(4, 6), y: TAB_Y },
  { frame: beat.dmReturn, x: tabX(4, 6), y: TAB_Y, click: true },
  idle(beat.dmReturn + 10, 820, 700),
  { frame: beat.nudge1Dismiss - 9, x: HIT.toastClose.x, y: HIT.toastClose.y },
  { frame: beat.nudge1Dismiss, x: HIT.toastClose.x, y: HIT.toastClose.y, click: true },
  idle(beat.nudge1Dismiss + 10, 820, 700),

  /* ---------------------------------------------------------------- S4 (643–869)
   * The landing is the slow part: the listing grid is scrolled for the best part of a
   * second before anything is picked. What follows is not a loop — the pointer goes to the
   * rail, to the Back button, into the mall's own search box and onto two different grids,
   * and it crosses the page for every one of them. Six additions, six different routes.
   */
  { frame: beat.portalEnter - 4, x: newTabX(6), y: TAB_Y },
  { frame: beat.portalEnter, x: newTabX(6), y: TAB_Y, click: true },
  { frame: beat.shopEnter - 8, x: HIT.portalAd.x, y: HIT.portalAd.y },
  { frame: beat.shopEnter - 2, x: HIT.portalAd.x, y: HIT.portalAd.y, click: true },
  idle(beat.shopEnter + 8, 640, 520),
  idle(beat.shopEnter + 14, 600, 380),
  { frame: beat.shopPick - 5, x: mallHit(beat.shopPick).x, y: mallHit(beat.shopPick).y },
  { frame: beat.shopPick, x: mallHit(beat.shopPick).x, y: mallHit(beat.shopPick).y, click: true },
  { frame: beat.cart1, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.hop1, x: mallHit(beat.hop1).x, y: mallHit(beat.hop1).y, click: true },
  { frame: beat.cart2, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  // Nudge #2 arrives; the hand hesitates on the button before going for `5분만`.
  idle(beat.nudge2In + 8, HIT.shopAdd.x, HIT.shopAdd.y),
  { frame: beat.snoozeClick - 12, x: HIT.toastBreak.x, y: HIT.toastBreak.y },
  { frame: beat.snoozeClick, x: HIT.toastBreak.x, y: HIT.toastBreak.y, click: true },
  { frame: beat.hop2, x: mallHit(beat.hop2).x, y: mallHit(beat.hop2).y, click: true },
  { frame: beat.cart3, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  // All the way back across the window to the Back button, and out again down the rail.
  { frame: beat.backClick, x: HIT.navBack.x, y: HIT.navBack.y, click: true },
  { frame: beat.hop3, x: mallHit(beat.hop3).x, y: mallHit(beat.hop3).y, click: true },
  { frame: beat.cart4, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek1 - 4, x: tabX(4, 8), y: TAB_Y },
  { frame: beat.dmPeek1, x: tabX(4, 8), y: TAB_Y, click: true },
  idle(beat.dmPeek1 + 8, 700, 620),
  { frame: beat.dmPeek1End - 4, x: tabX(7, 8), y: TAB_Y },
  { frame: beat.dmPeek1End, x: tabX(7, 8), y: TAB_Y, click: true },
  // Into the mall's own search box — the hand leaves it alone while the query is typed.
  { frame: beat.shopSearch, x: HIT.shopSearch.x, y: HIT.shopSearch.y, click: true },
  idle(beat.searchResults + 2, HIT.shopSearch.x + 26, HIT.shopSearch.y + 14),
  { frame: beat.searchPick - 5, x: mallHit(beat.searchPick).x, y: mallHit(beat.searchPick).y },
  { frame: beat.searchPick, x: mallHit(beat.searchPick).x, y: mallHit(beat.searchPick).y, click: true },
  { frame: beat.cart5, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.dmPeek2 - 4, x: tabX(4, 8), y: TAB_Y },
  { frame: beat.dmPeek2, x: tabX(4, 8), y: TAB_Y, click: true },
  idle(beat.dmPeek2 + 8, 700, 620),
  { frame: beat.dmPeek2End - 4, x: tabX(7, 8), y: TAB_Y },
  { frame: beat.dmPeek2End, x: tabX(7, 8), y: TAB_Y, click: true },
  { frame: beat.hop4, x: mallHit(beat.hop4).x, y: mallHit(beat.hop4).y, click: true },
  { frame: beat.cart6, x: HIT.shopAdd.x, y: HIT.shopAdd.y, click: true },
  { frame: beat.cartViewEnter, x: HIT.shopCart.x, y: HIT.shopCart.y, click: true },
  { frame: beat.cartViewEnter + 10, x: 700, y: 430 },
  // Dead still across the freeze — any drift undercuts the pause.
  { frame: beat.freezeEnd, x: 700, y: 430 },

  /* ---------------------------------------------------------------- S6 (929–1025) */
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

  /* ---------------------------------------------------------------- S7 (1025–1187) */
  { frame: beat.switchToEditor6 + 4, x: HIT.read.x, y: HIT.read.y, hidden: true },
  { frame: reappear(beat.switchToBrowser6, beat.mailOpen), x: 620, y: 300, hidden: false },
  { frame: beat.mailOpen - 3, x: newTabX(5), y: TAB_Y },
  { frame: beat.mailOpen, x: newTabX(5), y: TAB_Y, click: true },
  { frame: beat.sendClick - 7, x: HIT.mailSend.x, y: HIT.mailSend.y },
  { frame: beat.sendClick, x: HIT.mailSend.x, y: HIT.mailSend.y, click: true },
  { frame: beat.popupOpen2 - 4, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen2, x: EXT.x, y: EXT.y, click: true },
  { frame: beat.endSessionClick - 5, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
  { frame: beat.endSessionClick, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y, click: true },
  { frame: beat.endCardIn - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
];

/* ------------------------------------------------------------------ input sound */

/**
 * The compose box types whatever outgoing message is coming next, finishing exactly as
 * that bubble lands — the same derivation `dmPage` runs per frame, unrolled into runs.
 *
 * Message j is on screen from `from + (j - first) * step`, which is both the frame the
 * compose box starts typing it and the frame the previous bubble landed. Everything here
 * has to stay a restatement of that one line in `dmPage`; a segment's rate is its length
 * divided by its message count, and nothing in this file may round it differently.
 */
const dmComposeRuns = (): TypingRun[] => {
  const runs: TypingRun[] = [];
  for (const seg of dmSegments) {
    const log = DM_LOGS[seg.thread] ?? [];
    const step = (seg.to - seg.from) / Math.max(1, seg.last - seg.first);
    for (let j = seg.first; j < Math.min(seg.last, log.length); j++) {
      if (!log[j].out) continue;
      runs.push({
        from: seg.from + (j - seg.first) * step,
        text: log[j].text,
        fpc: step / Math.max(1, log[j].chars),
      });
    }
  }
  return runs;
};

/**
 * Every run of text the film types on camera.
 *
 * Each entry restates the three arguments of a `typed()` call above it, which is why the
 * rates are named constants rather than literals: this list is not allowed to have its
 * own opinion about how fast anything is typed. A block that lands whole — the pastes,
 * and everything written while the browser covers the writing app — contributes nothing,
 * because nothing was seen being typed.
 */
/**
 * The frames the writing app goes behind the browser, i.e. where a block still being
 * typed stops being watched. `applySwitch` flips at the switcher's midpoint, so that is
 * the frame the document is covered on, not the frame the gesture starts.
 */
const EDITOR_OFF = [
  beat.switchToBrowser1,
  beat.switchToBrowser2,
  beat.switchToBrowser3,
  beat.switchToBrowser4,
  beat.switchToBrowser5,
  beat.switchToBrowser6,
].map((f) => f + Math.round(SWITCHER_FRAMES / 2));

export const TYPING_RUNS: readonly TypingRun[] = [
  // The goal field is taken away by 시작 before the sentence finishes — see `until`.
  { from: beat.goalTypeStart, text: GOAL, fpc: GOAL_RATE, until: beat.startClick },
  ...CYCLES.map((c) => ({ from: c.searchAt - SEARCH_LEAD, text: SEARCHES[c.set].query, fpc: SEARCH_RATE })),
  // The one character anybody actually types into an address bar.
  { from: beat.omniType - 1, text: omniSocial.typed, fpc: 1 },
  { from: beat.portalQuery, text: PORTAL_QUERY, fpc: PORTAL_RATE },
  // The mall's own search box — the one query in the film that is typed into a page rather
  // than into the address bar.
  { from: beat.shopSearch + 1, text: SHOP_QUERY, fpc: SHOP_QUERY_RATE },
  // The page loads under the address bar while the query is still going in.
  { from: beat.newResearchTab + 2, text: researchQuery, fpc: RESEARCH_RATE, until: beat.researchLoad },
  ...WRITING.flatMap((ev, i) => {
    if (ev.whole || (ev.block.t !== "h" && ev.block.t !== "p")) return [];
    return [{ from: ev.at - 1, text: ev.block.text, fpc: rateFor(i), until: EDITOR_OFF.find((f) => f > ev.at) }];
  }),
  ...dmComposeRuns(),
];

/**
 * Single presses. `KEY_HINTS` is already the authored list of keys the film puts a chip
 * on screen for; the rest are the Enters that submit a query, placed where the typing
 * ends rather than where the page turns, so a retime carries them.
 */
export const KEY_PRESSES: readonly KeyPress[] = [
  ...KEY_HINTS.map((k) => ({ at: k.at })),
  ...CYCLES.map((c) => ({
    at: typedEnd(SEARCHES[c.set].query, c.searchAt - SEARCH_LEAD, SEARCH_RATE) + 2,
  })),
  { at: typedEnd(PORTAL_QUERY, beat.portalQuery, PORTAL_RATE) + 2 },
  { at: typedEnd(SHOP_QUERY, beat.shopSearch + 1, SHOP_QUERY_RATE) + 2 },
  { at: typedEnd(researchQuery, beat.newResearchTab + 2, RESEARCH_RATE) + 2 },
];

/** Everything the hands do, as one ordered cue list for `Main` to mount. */
export const INPUT_SFX: readonly SfxCue[] = mergeInput(
  keyboardCues(TYPING_RUNS, KEY_PRESSES, driveAt),
  clickCues(CURSOR_PATH, driveAt),
);

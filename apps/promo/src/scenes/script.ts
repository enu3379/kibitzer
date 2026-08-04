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

const TAB = {
  newtab: { id: "newtab", site: "newtab", title: "새 탭" },
  news: { id: "news", site: "news", title: tabTitles.news },
  stats: { id: "stats", site: "stats", title: tabTitles.stats },
  tube1: { id: "tube1", site: "tube", title: tabTitles.tube1 },
  tube2: { id: "tube2", site: "tube", title: tabTitles.tube2 },
  tube3: { id: "tube3", site: "tube", title: tabTitles.tube3 },
  mail: { id: "mail", site: "mail", title: tabTitles.mail },
} as const satisfies Record<string, TabSpec>;

const URL = {
  newtab: "새 탭",
  news: "commerceweekly.com/analysis/how-marketplaces-buy-their-first-million-customers",
  stats: "app.marketpulse.io/acquisition/channels",
  tube1: "metube.com/watch?v=8kR2vQ",
  tube2: "metube.com/watch?v=Lp0zXe",
  tube3: "metube.com/watch?v=Qm4Ttb",
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
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
  st.dot = "none";

  if (frame < beat.statsEnter) {
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

/* ------------------------------------------------------------------ S3 — first drift */

const s3 = (frame: number, st: Stage): void => {
  st.editor = editorDoc([...report.outline], false);
  st.focus = "editor";
  applySwitch(frame, st, beat.switchToBrowser1, "browser");

  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
  st.activeId = "stats";
  st.url = URL.stats;
  st.page = { k: "stats", reveal: 1 };
  st.dot = "none";

  if (frame < beat.tubeEnter) return;

  st.tabs.push({ ...TAB.tube1 });
  st.activeId = "tube1";
  st.url = URL.tube1;
  st.page = { k: "tube", video: 0, progress: range(frame, [beat.tubeEnter, beat.tubeSecondVideo], [0.05, 0.24], Easing.linear) };

  if (frame >= beat.tubeSecondVideo) {
    st.tabs.push({ ...TAB.tube2 });
    st.activeId = "tube2";
    st.url = URL.tube2;
    st.page = {
      k: "tube",
      video: 1,
      progress: range(frame, [beat.tubeSecondVideo, scene.s4Escalate.from], [0.02, 0.09], Easing.linear),
    };
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
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }, { ...TAB.tube1 }, { ...TAB.tube2 }];
  st.activeId = "tube2";
  st.url = URL.tube2;
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
    st.page = {
      k: "tube",
      video: 1,
      progress: range(frame, [scene.s4Escalate.from, beat.montageStart], [0.09, 0.2], Easing.linear),
    };
    return;
  }

  /*
   * Time-lapse. One eased sweep across three videos: quadratic ease-in so the later
   * clips whip past, which reads as "time got away from you" far better than a scroll.
   * The third clip autoplays inside the same tab, so that tab's title follows the video.
   */
  const mp = range(frame, [beat.montageStart, beat.montageEnd], [0, 3], Easing.in(Easing.quad));
  const idx = Math.min(2, Math.floor(mp));
  const local = Math.min(1, mp - idx);
  const video = 1 + idx;
  st.page = { k: "tube", video, progress: 0.08 + local * 0.9 };

  if (idx >= 1) {
    st.tabs.push({ ...TAB.tube3, title: idx >= 2 ? tabTitles.tube4 : tabTitles.tube3 });
    st.activeId = "tube3";
    st.url = URL.tube3;
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
  st.tabs = [
    { ...TAB.news },
    { ...TAB.stats },
    { ...TAB.tube1, width: collapse(frame, beat.closeTab1) },
    { ...TAB.tube2, width: collapse(frame, beat.closeTab2) },
    { ...TAB.tube3, title: tabTitles.tube4, width: collapse(frame, beat.closeTab3) },
  ];

  // Freeze: everything holds and the frame pushes in 5%. The menu bar stays put.
  st.zoom = Math.min(
    range(frame, [beat.freezeStart, beat.freezeStart + 22], [1, 1.04]),
    range(frame, [beat.freezeEnd + 8, beat.freezeEnd + 28], [1.04, 1]),
  );

  const returned = frame >= beat.closeTab3 + 8;
  st.activeId = returned ? "stats" : "tube3";
  st.url = returned ? URL.stats : URL.tube3;
  st.dot = frame >= beat.returnToGoalTab ? "none" : "red";
  st.page = returned ? { k: "stats", reveal: 1 } : { k: "tube", video: 3, progress: 0.97 };

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
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
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
  st.tabs = [{ ...TAB.news }, { ...TAB.stats }];
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

  // S2 — read, check the numbers, then Cmd-Tab into the writing app
  { frame: 178, x: tabX(1, 2), y: TAB_Y },
  { frame: beat.statsEnter, x: tabX(1, 2), y: TAB_Y, click: true },
  { frame: 200, x: 600, y: 430, hidden: false },
  { frame: beat.switchToEditor1 + 6, x: 600, y: 430, hidden: true },

  // S3 — back to the browser and off to a video
  { frame: beat.switchToBrowser1 + 8, x: 620, y: 300, hidden: false },
  { frame: beat.tubeEnter - 4, x: 640, y: 62 },
  { frame: beat.tubeEnter, x: 640, y: 62, click: true },
  { frame: beat.tubeEnter + 18, x: 640, y: 480 },
  { frame: 370, x: HIT.toastClose.x, y: HIT.toastClose.y },
  { frame: beat.nudge1Dismiss, x: HIT.toastClose.x, y: HIT.toastClose.y, click: true },
  { frame: 398, x: 700, y: 470 },

  // S4 — pressing "5분만", then out of the way for the montage
  { frame: 458, x: HIT.toastBreak.x, y: HIT.toastBreak.y },
  { frame: beat.snoozeClick, x: HIT.toastBreak.x, y: HIT.toastBreak.y, click: true },
  { frame: 486, x: 660, y: 540 },
  // Hold dead still across the montage and the freeze — any drift undercuts the pause.
  { frame: beat.freezeEnd, x: 660, y: 540 },

  // S5 — closing the mess, one tab at a time (each close slides the next into place)
  { frame: beat.closeTab1 - 4, x: tabCloseX(2, 5), y: TAB_Y },
  { frame: beat.closeTab1, x: tabCloseX(2, 5), y: TAB_Y, click: true },
  { frame: beat.closeTab2, x: tabCloseX(2, 5), y: TAB_Y, click: true },
  { frame: beat.closeTab3, x: tabCloseX(2, 5), y: TAB_Y, click: true },
  { frame: beat.returnToGoalTab, x: tabX(1, 2), y: TAB_Y, click: true },
  { frame: 756, x: 600, y: 430 },

  // S6 — praise lands, then Cmd-Tab back to writing
  { frame: beat.switchToEditor2 + 6, x: 600, y: 430, hidden: true },

  // S7 — Cmd-Tab back, compose, send, then end the session
  { frame: beat.switchToBrowser2 + 6, x: 620, y: 300, hidden: false },
  { frame: beat.mailOpen - 8, x: 640, y: 62 },
  { frame: beat.mailOpen - 2, x: 640, y: 62, click: true },
  { frame: beat.sendClick - 10, x: HIT.mailSend.x, y: HIT.mailSend.y },
  { frame: beat.sendClick, x: HIT.mailSend.x, y: HIT.mailSend.y, click: true },
  { frame: beat.popupOpen2 - 6, x: EXT.x, y: EXT.y },
  { frame: beat.popupOpen2, x: EXT.x, y: EXT.y, click: true },
  { frame: beat.endSessionClick - 6, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
  { frame: beat.endSessionClick, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y, click: true },
  { frame: 968, x: HIT.endSessionBtn.x, y: HIT.endSessionBtn.y },
];

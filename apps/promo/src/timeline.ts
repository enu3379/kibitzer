/**
 * Single source of truth for every beat in the promo.
 *
 * Scenes are laid out back to back; every in-scene beat below is an ABSOLUTE frame on
 * the master timeline so that scene components, audio cues and the still-render script
 * can all point at the same number. Retiming the video means editing this file only.
 *
 * CONSTRAINT: a beat must sit at or after the `from` of the scene whose function applies
 * it, or that scene never runs and the beat silently does nothing.
 */
import { FPS } from "./theme";

/**
 * PACING RULE — landings are slow, runs are fast.
 *
 * Every scene opens on a page nobody has seen before, and the film used to cut away from
 * it at the same speed it cut between two pages the audience already knew. So each arrival
 * now gets a hold at roughly 0.7× before the tempo comes back up: half a second on the
 * social feed before the messages open, most of a second on the mall's listing grid before
 * anything is clicked. What follows the hold keeps the old speed.
 *
 * The runs themselves are budgeted rather than counted: a DM segment or a typed block gets
 * a FIXED window and derives its own rate from however much content it has to deliver (see
 * `rateFor` and `dmSegments` in scenes/script.ts). Adding three more messages to a thread
 * makes the thread faster, never longer.
 */
export const scene = {
  /** New tab on screen, cursor crosses to the icon, goal declared. */
  s1Setup: { from: 0, duration: 66 },
  /** Search → read → write, three times over. Paced as a parabola (see below). */
  s2Research: { from: 66, duration: 240 },
  /** Drift #1 — direct messages, plus the music link that arrives inside them. */
  s3Messages: { from: 306, duration: 232 },
  /** Drift #2/#3 — portal → mall, interleaved with the messages piling up. */
  s4Shopping: { from: 538, duration: 226 },
  /** Everything stops. The only slow thing left in the middle of the film. */
  s5Freeze: { from: 764, duration: 60 },
  /** Clear the mess, look at the document, pick a new research thread. */
  s6Reset: { from: 824, duration: 96 },
  /** Praise carries over, the report is finished, the mail goes out, session ends. */
  s7WrapUp: { from: 920, duration: 162 },
  s8EndCard: { from: 1082, duration: 70 },
} as const;

export const TOTAL_FRAMES = scene.s8EndCard.from + scene.s8EndCard.duration; // 1152 = 38.4s

/**
 * How long the Cmd-Tab switcher stays up. Short: at this tempo there are ten app
 * switches, and a nine-frame overlay each time would eat a fifth of the research scene.
 */
export const SWITCHER_FRAMES = 6;

export const beat = {
  /* --------------------------------------------------------- S1 goal declaration (66f)
   * Opens on the new-tab page with the pointer parked mid-screen; the first thing that
   * happens in the film is the cursor crossing to the Kibitzer icon.
   */
  popupOpen: 16,
  goalTypeStart: 23,
  goalTypeEnd: 47,
  startClick: 55,
  popupClose: 61,

  /* --------------------------------------------------------- S2 the research loop (240f)
   *
   * Three search-and-read cycles, not three visits to the same two tabs: each one goes
   * back to the results page, picks a *different* source, opens it, and comes back to the
   * document. Three distinct pages get opened this way.
   *
   * Paced as a parabola. The opening runs at a speed you can follow — twelve frames on the
   * results page, twenty reading the article — then the five seconds in the middle ramp up,
   * blur, and come back down. At the peak a source page is on screen for eleven frames and
   * a paragraph lands in twelve, which is not typing so much as the memory of having typed.
   *
   * The long method-and-findings blocks run at 0.02 frames per character inside the
   * stretches where the browser covers the writing app. Those are the stretches the
   * menu-bar clock spins through: off camera, the writer kept writing.
   */

  /* --- opening: find the first source properly (readable speed) */
  searchEnter1: 68,
  result1Click: 80,
  newsEnter: 82,

  /* --- cycle A: write, then go find the numbers
   * The off-camera beats are named for the section they deliver, because that is the only
   * thing that identifies them — none of them is ever seen landing.
   */
  switchToEditor1: 102,
  /** §1 heading. */
  writeH1: 108,
  writeP1: 115,
  writeP2: 125,
  switchToBrowser1: 133,
  /** off camera — rest of §1: the LTV/CAC critique, prior work, the research questions. */
  writeIntroBody: 139,
  searchEnter2: 139,
  /** off camera — §2.1–2.3: sample, operational definitions, caveats. */
  writeMethod: 143,
  result2Click: 146,
  statsEnter: 148,

  /* --- cycle B: copy the channel table into the report */
  select1: 154,
  /** off camera — §2.4 descriptive statistics, ending on the line [자료 1] lands under. */
  writeStats: 157,
  copy1: 160,
  switchToEditor2: 164,
  paste1: 170,
  /** §3 heading. */
  writeH2: 175,
  writeP6: 182,

  /* --- cycle C: the peak. A third source, up for eleven frames. */
  switchToBrowser2: 191,
  /** off camera — §3.1 coupons, and the §3.2 sub-head the next typed block opens under. */
  writeCoupon: 195,
  searchEnter3: 197,
  result3Click: 201,
  cohortsEnter: 202,
  switchToEditor3: 213,
  /** Typed at the fastest rate in the film, and abandoned when the cut leaves. */
  writeP8: 218,

  /* --- coming back down: the pull quote, then the boil comes off */
  switchToBrowser3: 226,
  newsReturn: 229,
  select2: 233,
  /** off camera — rest of §3.2, the cohort table [자료 2], and §3.3 curation. */
  writeCuration: 236,
  copy2: 239,
  switchToEditor4: 242,
  paste2: 248,
  writeP10: 254,
  /** Four times slower than the block before it. This is where attention goes. */
  writeP11: 260,
  enter1: 283,
  enter2: 288,
  /** 288 → 306: six tenths of a second with nothing on screen but a blinking caret. */

  /* --------------------------------------------------------- S3 drift #1: messages (232f)
   *
   * Two landings and then a run. The social feed gets a full second before the messages
   * are opened, and the thread that opens gets half a second of sitting there before
   * anything moves — that is the 0.7× hold, and it is what makes the run afterwards read
   * as fast instead of as the same speed as everything else.
   *
   * The run is one long conversation and two errands. 민아 is the friend: a real
   * back-and-forth that starts here, keeps going while the tab is elsewhere, and is still
   * going at the end of the film. 준호 and 다영 are piles — four unread, read at a glance,
   * one reply out, done. The segment windows are fixed (see `dmSegments`); the message
   * rate inside each is derived from them, so more chat never costs more screen time.
   */
  switchToBrowser4: 306,
  newTabClick: 318,
  omniType: 325,
  omniSuggest: 331,
  omniTab: 338,
  igEnter: 344,
  /** Landing: the feed holds for a second before the messages are opened. */
  igDmEnter: 374,
  /** Landing: the open thread sits still for half a second before it starts moving. */
  dmRun1: 388,
  dmReply1: 402,
  dmSwitch2: 424,
  dmReply2: 432,
  /** A third thread lights up mid-reply and wins. */
  dmInterrupt: 438,
  dmSwitch3: 444,
  musicLink: 464,
  musicOpen: 474,
  dmReturn: 488,
  /*
   * The badge no longer needs a beat of its own: it is a continuous read of the gauge
   * (GAUGE in scenes/script.ts), so it has already gone amber and then red on its own by
   * the time the first nudge fires. S is spent exactly here, which is what triggers it —
   * the first nag is the downward crossing into zero.
   */
  nudge1In: 496,
  nudge1Dismiss: 528,

  /* --------------------------------------------------------- S4 drift #2/#3: mall (226f)
   *
   * The mall gets the longest landing in the film: twenty-four frames on the listing grid,
   * scrolling, before anything is clicked. It has to read as "this is a shopping site"
   * before the spree can mean anything — and once it has, the page changes are cut to the
   * bone.
   *
   * The spree itself is a loop, not a montage: product page → 장바구니 → the badge pops
   * top right → click something off the 함께 본 상품 rail → the next product page. Each
   * `hop` is that click. It is how a mall actually keeps somebody, which is the point the
   * report being neglected is literally about.
   *
   * Nudge #2 lands *after* the spree has started, not on the messages before it. A nudge
   * can only name what is on screen, and what is on screen here is someone researching
   * customer acquisition while being acquired. It also gives the beat a shape: two items
   * go in the cart, the nudge stops it, the snooze restarts it, five more go in.
   */
  portalEnter: 546,
  portalQuery: 552,
  /** The mall opens on its listing page; the pick happens after a long, readable scroll. */
  shopEnter: 566,
  shopPick: 590,
  cart1: 598,
  hop1: 606,
  cart2: 612,
  nudge2In: 618,
  snoozeClick: 648,
  hop2: 656,
  cart3: 662,
  hop3: 668,
  cart4: 674,
  dmPeek1: 680,
  dmPeek1End: 696,
  hop4: 702,
  cart5: 708,
  hop5: 714,
  cart6: 720,
  dmPeek2: 726,
  dmPeek2End: 740,
  hop6: 746,
  cart7: 752,
  cartViewEnter: 758,
  nudge3In: 762,

  /* --------------------------------------------------------- S5 the stop (60f) */
  freezeStart: 774,
  freezeEnd: 810,

  /* --------------------------------------------------------- S6 clear + restart (96f) */
  closeTab1: 830, // shop
  closeTab2: 838, // portal
  closeTab3: 846, // music
  closeTab4: 854, // messages
  returnToGoalTab: 864,
  /** Open the document once — long enough to see the empty line it was left on. */
  switchToEditor5: 872,
  switchToBrowser5: 892,
  newResearchTab: 899,
  /** off camera — §3.4, the soft conclusion the drift interrupted mid-thought. */
  writeSynthesis: 901,
  researchLoad: 908,
  praiseIn: 910,
  /** off camera — §4, the size-band analysis, and the figure that closes it. */
  writeRetention: 914,

  /* --------------------------------------------------------- S7 finish + wrap up (162f) */
  praiseOut: 942,
  switchToEditor6: 946,
  /** §5 heading — the conclusion, and the last thing typed on camera. */
  writeH3: 954,
  writeP12: 962,
  writeP13: 972,
  writeP14: 984,
  /**
   * The bibliography lands, and the document is finished. The figure it refers to was
   * already written into §4 off camera — a figure belongs in the section that analyses
   * it, and putting the reference list last is what makes the closing frame read as a
   * paper rather than as a slide.
   */
  chartIn: 996,
  switchToBrowser6: 1012,
  mailOpen: 1018,
  sendClick: 1032,
  mailSent: 1040,
  /*
   * The closing look at the popup: the immersion bar back at the top with the sundial's
   * shadow at its longest, then 종료하기 into the session summary — the one screen that
   * reports on the whole two hours.
   */
  popupOpen2: 1046,
  endSessionClick: 1058,
  summaryShown: 1060,

  /* --------------------------------------------------------- S8 (70f) */
  endCardIn: 1082,
} as const;

/**
 * Drive — how hard the film is pushing at this frame, 0–1.
 *
 * The keystroke and click sounds are cut against this rather than laid down at one rate,
 * because a uniform rate says the wrong thing. The research loop is written as a parabola
 * and the mall is written as an accelerating loop; played at a flat fifteen keys a second
 * both of them sound like the same afternoon, and the one thing the film is about is that
 * they are not. So the sound thickens where the picture accelerates and thins where it
 * lets go — see `keyboardCues` in lib/inputsfx.ts, which spends this on the minimum gap
 * between two strikes, and on level.
 *
 * This cannot be read off `GAUGE`. S is flat at 100 through the whole of the research loop
 * and flat at 0 through the whole of the spree — it measures whether the work is on goal,
 * not how fast it is going, and those are different curves. Nor is it `clockRushAt`, which
 * spikes on every Cmd-Tab regardless of what the hands are doing. It is a directorial
 * curve, so it is authored, and the anchors are the beats it is describing:
 *
 *   · S2 climbs to 1.0 at `writeP8` — the fastest rate in the film — then comes off the
 *     boil hard: `writeP11` is four times slower than the block before it, and the caret
 *     void after it is the quietest frame in the first half.
 *   · S3 opens low and builds as the thread takes over.
 *   · S4 stops dead at `nudge2In`, restarts on the snooze, and tops out at `cart7`.
 *   · S5 is zero. Nothing moves in the freeze, including the sound.
 *
 * Anchors interpolate linearly and must stay in ascending frame order.
 */
const DRIVE: ReadonlyArray<readonly [frame: number, v: number]> = [
  [0, 0.15],
  [beat.goalTypeStart, 0.6],
  [beat.startClick, 0.5],
  /* S2 — the parabola */
  [beat.searchEnter1, 0.35],
  [beat.newsEnter, 0.35],
  [beat.writeH1, 0.45],
  [beat.searchEnter2, 0.6],
  [beat.paste1, 0.75],
  [beat.searchEnter3, 0.9],
  [beat.writeP8, 1],
  [beat.newsReturn, 0.8],
  [beat.writeP10, 0.5],
  [beat.writeP11, 0.22],
  [beat.enter2, 0.1],
  [scene.s3Messages.from, 0.05],
  /* S3 — the thread takes over */
  [beat.newTabClick, 0.25],
  [beat.igEnter, 0.3],
  [beat.dmRun1, 0.35],
  [beat.dmSwitch2, 0.6],
  [beat.dmSwitch3, 0.7],
  [beat.dmReturn, 0.75],
  [beat.nudge1In, 0.7],
  /* S4 — the spree */
  [beat.portalQuery, 0.5],
  [beat.shopPick, 0.65],
  [beat.cart2, 0.8],
  [beat.nudge2In, 0.55],
  [beat.snoozeClick, 0.6],
  [beat.cart4, 0.85],
  [beat.cart6, 0.95],
  [beat.cart7, 1],
  [beat.nudge3In, 0.9],
  /* S5 — everything stops */
  [beat.freezeStart, 0],
  [beat.freezeEnd, 0],
  /* S6/S7 — back to work, then winding down */
  [beat.closeTab1, 0.35],
  [beat.newResearchTab, 0.45],
  [beat.writeH3, 0.6],
  [beat.writeP14, 0.5],
  [beat.chartIn, 0.35],
  [beat.mailOpen, 0.3],
  [beat.endCardIn, 0.2],
];

export const driveAt = (frame: number): number => {
  if (frame <= DRIVE[0][0]) return DRIVE[0][1];
  for (let i = 1; i < DRIVE.length; i += 1) {
    const [f1, v1] = DRIVE[i];
    if (frame <= f1) {
      const [f0, v0] = DRIVE[i - 1];
      return f1 === f0 ? v1 : v0 + ((v1 - v0) * (frame - f0)) / (f1 - f0);
    }
  }
  return DRIVE[DRIVE.length - 1][1];
};

/** Audio cues — file + absolute frame of the visual it must land on. */
export const sfx = [
  { file: "sfx/ding.wav", at: beat.nudge1In },
  { file: "sfx/ding.wav", at: beat.nudge2In },
  { file: "sfx/ding.wav", at: beat.nudge3In },
  { file: "sfx/celebrate.wav", at: beat.praiseIn },
] as const;

/**
 * Menu-bar clock — a dial that speeds up and slows down, not a label that snaps.
 *
 * Each anchor pins a frame to the minute it must display; between two anchors the time
 * *runs*, eased in and out, so a stretch that covers fifteen minutes spends half a second
 * visibly spinning through them. Where the film is watching something in real time the
 * two ends of a segment carry the same minute, and the clock simply holds — the S1 setup,
 * the caret void at the end of S2, and the whole of the S5 freeze are flat on purpose.
 *
 * The rate is what the audience actually reads. A hold says "this is happening now"; a
 * blur of digits says "an hour of this went by". Snapping said neither, because a value
 * that changes between two frames and never again is indistinguishable from a cut.
 *
 * Anchors must be in strictly ascending frame order — a zero-width segment divides by
 * zero, and an inverted one runs time backwards.
 *
 * Two spans carry copy that has to be literally true on screen:
 *   snoozeClick 3:15 → nudge3In 3:29   = "벌써 14분째"
 *   igEnter 3:04 → returnToGoalTab 3:30 = "26분 만의 복귀"
 * Three of those four frames are anchors. nudge3In is not, but it sits inside the flat
 * cartViewEnter → freezeEnd segment, so it reads 3:29 exactly and stays there through the
 * freeze — which is the one moment in the film the audience has time to read the clock.
 */
type ClockAnchor = { at: number; min: number };

/** 오후 2:00, in minutes past midnight. */
const CLOCK_ORIGIN = 14 * 60;

export const clockAnchors: readonly ClockAnchor[] = [
  { at: 0, min: 0 },
  /* S1 — two seconds of real time; the clock does not move. */
  { at: scene.s2Research.from, min: 0 },
  /* S2 — finding, reading, and the stretches where the browser covers the writing. */
  { at: beat.newsEnter, min: 4 },
  { at: beat.switchToEditor1, min: 11 },
  /** On camera in the writing app: near real time. */
  { at: beat.switchToBrowser1, min: 13 },
  /** First run-up — thirteen minutes in fourteen frames. */
  { at: beat.statsEnter, min: 26 },
  { at: beat.copy1, min: 28 },
  { at: beat.paste1, min: 33 },
  { at: beat.switchToBrowser2, min: 36 },
  { at: beat.cohortsEnter, min: 41 },
  { at: beat.switchToEditor3, min: 42 },
  { at: beat.switchToBrowser3, min: 44 },
  /** The last and longest run-up, straight into the slowdown. */
  { at: beat.switchToEditor4, min: 55 },
  { at: beat.writeP11, min: 58 },
  { at: beat.enter2, min: 62 },
  /** Nothing on screen but a caret — and a clock that has stopped with it. */
  { at: scene.s3Messages.from, min: 62 },
  /* S3–S4 — the drift runs close to real time; it is meant to feel like no time at all. */
  { at: beat.igEnter, min: 64 },
  { at: beat.igDmEnter, min: 66 },
  { at: beat.musicOpen, min: 69 },
  { at: beat.nudge1In, min: 71 },
  { at: beat.portalEnter, min: 72 },
  { at: beat.shopEnter, min: 73 },
  { at: beat.nudge2In, min: 74 },
  /** 3:15 — the minute nudge #3 counts fourteen from. */
  { at: beat.snoozeClick, min: 75 },
  { at: beat.cart3, min: 76 },
  { at: beat.cart5, min: 81 },
  { at: beat.cart7, min: 88 },
  { at: beat.cartViewEnter, min: 89 },
  /** S5 — everything stops, the clock included. */
  { at: beat.freezeEnd, min: 89 },
  { at: beat.returnToGoalTab, min: 90 },
  /* S6–S7 */
  { at: beat.praiseIn, min: 91 },
  { at: beat.switchToEditor6, min: 98 },
  /**
   * The conclusion is typed on camera, so it costs about what it looks like it costs —
   * and the run-up holds off until the finished document has had a few frames to read.
   */
  { at: beat.chartIn + 4, min: 101 },
  /** Done writing — the last run-up covers exporting, attaching, and opening the mail. */
  { at: beat.mailOpen, min: 112 },
  { at: beat.popupOpen2, min: 115 },
  { at: TOTAL_FRAMES, min: 115 },
];

/** Accelerate, run, settle. The easing is the whole effect. */
const easeInOut = (p: number): number => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);

/** Minutes past midnight at `frame`. Fractional — `frame` may be fractional too. */
export const clockMinutesAt = (frame: number): number => {
  if (frame <= clockAnchors[0].at) return CLOCK_ORIGIN + clockAnchors[0].min;
  for (let i = 1; i < clockAnchors.length; i++) {
    const b = clockAnchors[i];
    if (frame > b.at) continue;
    const a = clockAnchors[i - 1];
    const span = a.min + (b.min - a.min) * easeInOut((frame - a.at) / (b.at - a.at));
    return CLOCK_ORIGIN + span;
  }
  return CLOCK_ORIGIN + clockAnchors[clockAnchors.length - 1].min;
};

export const clockAt = (frame: number): string => {
  // The epsilon keeps an anchor frame from landing on 88.99999 and displaying 3:28.
  const total = Math.floor(clockMinutesAt(frame) + 1e-6);
  const h24 = Math.floor(total / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h24 < 12 ? "오전" : "오후"} ${h12}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * How hard the clock is running right now, 0–1 — drives a little motion blur on the
 * digits. Below ~0.15 minutes per frame the minute changes slowly enough to read, and
 * blurring a readable clock would look like a defect rather than like speed.
 */
export const clockRushAt = (frame: number): number => {
  const perFrame = clockMinutesAt(frame + 0.5) - clockMinutesAt(frame - 0.5);
  return Math.max(0, Math.min(1, (perFrame - 0.15) / 0.85));
};

export const seconds = (frames: number): number => frames / FPS;

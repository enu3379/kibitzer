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

export const scene = {
  /** Two seconds flat: new tab on screen, cursor crosses to the icon, goal declared. */
  s1Setup: { from: 0, duration: 60 },
  /** Search → read → write, three times over. Paced as a parabola (see below). */
  s2Research: { from: 60, duration: 210 },
  /** Drift #1 — direct messages, plus the music link that arrives inside them. */
  s3Messages: { from: 270, duration: 190 },
  /** Drift #2/#3 — portal → mall, interleaved with the messages piling up. */
  s4Shopping: { from: 460, duration: 185 },
  /** Everything stops. The only slow thing left in the middle of the film. */
  s5Freeze: { from: 645, duration: 45 },
  /** Clear the mess, look at the document, pick a new research thread. */
  s6Reset: { from: 690, duration: 80 },
  /** Praise carries over, the report is finished, the mail goes out, session ends. */
  s7WrapUp: { from: 770, duration: 130 },
  s8EndCard: { from: 900, duration: 60 },
} as const;

export const TOTAL_FRAMES = scene.s8EndCard.from + scene.s8EndCard.duration; // 960 = 32.0s

/**
 * How long the Cmd-Tab switcher stays up. Short: at this tempo there are ten app
 * switches, and a nine-frame overlay each time would eat a fifth of the research scene.
 */
export const SWITCHER_FRAMES = 6;

export const beat = {
  /* --------------------------------------------------------- S1 goal declaration (60f)
   * Opens on the new-tab page with the pointer parked mid-screen; the first thing that
   * happens in the film is the cursor crossing to the Kibitzer icon.
   */
  popupOpen: 14,
  goalTypeStart: 21,
  goalTypeEnd: 43,
  startClick: 50,
  popupClose: 56,

  /* --------------------------------------------------------- S2 the research loop (210f)
   *
   * Three search-and-read cycles, not three visits to the same two tabs: each one goes
   * back to the results page, picks a *different* source, opens it, and comes back to the
   * document. Three distinct pages get opened this way.
   *
   * Paced as a parabola. Roughly a second at each end runs at a speed you can follow; the
   * five seconds between them ramp up, blur, and come back down. At the peak a source page
   * is on screen for ten frames and a paragraph lands in twelve — 0.1s per dozen
   * characters, which is not typing so much as the memory of having typed.
   *
   * The long method-and-findings blocks run at 0.02 frames per character inside the
   * stretches where the browser covers the writing app. Those are the stretches the
   * menu-bar clock spins through: off camera, the writer kept writing.
   */

  /* --- opening: find the first source properly (readable speed) */
  searchEnter1: 62,
  result1Click: 70,
  newsEnter: 72,

  /* --- cycle A: write, then go find the numbers
   * The off-camera beats are named for the section they deliver, because that is the only
   * thing that identifies them — none of them is ever seen landing.
   */
  switchToEditor1: 84,
  /** §1 heading. */
  writeH1: 90,
  writeP1: 97,
  writeP2: 108,
  switchToBrowser1: 114,
  /** off camera — rest of §1: the LTV/CAC critique, prior work, the research questions. */
  writeIntroBody: 120,
  searchEnter2: 120,
  /** off camera — §2.1–2.3: sample, operational definitions, caveats. */
  writeMethod: 124,
  result2Click: 126,
  statsEnter: 128,

  /* --- cycle B: copy the channel table into the report */
  select1: 133,
  /** off camera — §2.4 descriptive statistics, ending on the line [자료 1] lands under. */
  writeStats: 136,
  copy1: 139,
  switchToEditor2: 143,
  paste1: 149,
  /** §3 heading. */
  writeH2: 154,
  writeP6: 161,

  /* --- cycle C: the peak. A third source, up for ten frames. */
  switchToBrowser2: 170,
  /** off camera — §3.1 coupons, and the §3.2 sub-head the next typed block opens under. */
  writeCoupon: 174,
  searchEnter3: 176,
  result3Click: 180,
  cohortsEnter: 181,
  switchToEditor3: 190,
  /** Typed at the fastest rate in the film, and abandoned when the cut leaves. */
  writeP8: 195,

  /* --- coming back down: the pull quote, then the boil comes off */
  switchToBrowser3: 202,
  newsReturn: 205,
  select2: 209,
  /** off camera — rest of §3.2, the cohort table [자료 2], and §3.3 curation. */
  writeCuration: 212,
  copy2: 215,
  switchToEditor4: 218,
  paste2: 224,
  writeP10: 230,
  /** Four times slower than the block before it. This is where attention goes. */
  writeP11: 236,
  enter1: 255,
  enter2: 259,
  /** 259 → 270: nothing on screen but a blinking caret. */

  /* --------------------------------------------------------- S3 drift #1: messages (190f)
   * The landing keeps a readable pace; the chat run is where the tempo picks up again.
   */
  switchToBrowser4: 270,
  newTabClick: 280,
  omniType: 286,
  omniSuggest: 291,
  omniTab: 297,
  igEnter: 302,
  igDmEnter: 322,
  dmReply1: 330,
  dmSwitch2: 340,
  dmReply2: 349,
  /** A third thread lights up mid-reply and wins. */
  dmInterrupt: 356,
  dmSwitch3: 361,
  musicLink: 370,
  musicOpen: 378,
  dmReturn: 394,
  /*
   * The badge no longer needs a beat of its own: it is a continuous read of the gauge
   * (GAUGE in scenes/script.ts), so it has already gone amber and then red on its own by
   * the time the first nudge fires. S is spent exactly here, which is what triggers it —
   * the first nag is the downward crossing into zero.
   */
  nudge1In: 402,
  nudge1Dismiss: 440,

  /* --------------------------------------------------------- S4 drift #2/#3: mall (185f)
   * Page loads and scrolls are cut to the bone; what is left is the cart climbing and the
   * two trips back to the messages.
   *
   * Nudge #2 lands *after* the spree has started, not on the messages before it. A nudge
   * can only name what is on screen, and what is on screen here is someone researching
   * customer acquisition while being acquired — which is the joke the whole film is built
   * on. It also gives the beat a shape: two items go in the cart, the nudge stops it, the
   * snooze restarts it, five more go in.
   */
  portalEnter: 466,
  portalQuery: 470,
  /** The mall opens on its listing page; the pick happens after a short scroll. */
  shopEnter: 480,
  shopPick: 492,
  cart1: 497,
  cart2: 505,
  nudge2In: 512,
  snoozeClick: 538,
  cart3: 546,
  cart4: 552,
  dmPeek1: 558,
  dmPeek1End: 570,
  cart5: 576,
  cart6: 584,
  dmPeek2: 590,
  dmPeek2End: 600,
  cart7: 606,
  cartViewEnter: 611,
  nudge3In: 624,

  /* --------------------------------------------------------- S5 the stop (45f) */
  freezeStart: 645,
  freezeEnd: 675,

  /* --------------------------------------------------------- S6 clear + restart (80f) */
  closeTab1: 694, // shop
  closeTab2: 701, // portal
  closeTab3: 708, // music
  closeTab4: 715, // messages
  returnToGoalTab: 724,
  /** Open the document once — long enough to see the empty line it was left on. */
  switchToEditor5: 732,
  switchToBrowser5: 748,
  newResearchTab: 754,
  /** off camera — §3.4, the soft conclusion the drift interrupted mid-thought. */
  writeSynthesis: 756,
  researchLoad: 762,
  praiseIn: 764,
  /** off camera — §4, the size-band analysis, and the figure that closes it. */
  writeRetention: 768,

  /* --------------------------------------------------------- S7 finish + wrap up (130f) */
  praiseOut: 788,
  switchToEditor6: 792,
  /** §5 heading — the conclusion, and the last thing typed on camera. */
  writeH3: 798,
  writeP12: 804,
  writeP13: 812,
  writeP14: 822,
  /**
   * The bibliography lands, and the document is finished. The figure it refers to was
   * already written into §4 off camera — a figure belongs in the section that analyses
   * it, and putting the reference list last is what makes the closing frame read as a
   * paper rather than as a slide.
   */
  chartIn: 832,
  switchToBrowser6: 840,
  mailOpen: 846,
  sendClick: 858,
  mailSent: 864,
  /*
   * The closing look at the popup, and the last beat before the end card.
   *
   * There is no 세션 종료 button and no summary screen to open behind it — the extension
   * holds one goal until it is replaced, and its popup has only the setup and active
   * views. So this beat is not a click into anything; it is the gauge, read once, back at
   * the top. The 32 frames it now holds are what the summary screen used to spend.
   */
  popupOpen2: 868,

  /* --------------------------------------------------------- S8 (60f) */
  endCardIn: 900,
} as const;

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
 * Both endpoints are anchors, so they display exactly, whatever the easing does between.
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

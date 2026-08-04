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
   * stretches where the browser covers the writing app. That is the fifteen minutes the
   * menu-bar clock jumps over: off camera, the writer kept writing.
   */

  /* --- opening: find the first source properly (readable speed) */
  searchEnter1: 62,
  result1Click: 70,
  newsEnter: 72,

  /* --- cycle A: write, then go find the numbers */
  switchToEditor1: 84,
  writeH1: 90,
  writeP1: 97,
  writeP2: 108,
  switchToBrowser1: 114,
  writeP3: 120, // off camera
  searchEnter2: 120,
  writeP4: 124, // off camera
  result2Click: 126,
  statsEnter: 128,

  /* --- cycle B: copy the channel table into the report */
  select1: 133,
  writeP5: 136, // off camera
  copy1: 139,
  switchToEditor2: 143,
  paste1: 149,
  writeH2: 154,
  writeP6: 161,

  /* --- cycle C: the peak. A third source, up for ten frames. */
  switchToBrowser2: 170,
  writeP7: 174, // off camera
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
  writeP9: 212, // off camera
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
  dotRed1: 398,
  nudge1In: 402,
  nudge1Dismiss: 440,

  /* --------------------------------------------------------- S4 drift #2/#3: mall (185f)
   * Page loads and scrolls are cut to the bone; what is left is the cart climbing and the
   * two trips back to the messages.
   */
  nudge2In: 470,
  snoozeClick: 496,
  portalEnter: 502,
  portalQuery: 505,
  /** The mall opens on its listing page; the pick happens after a short scroll. */
  shopEnter: 516,
  shopPick: 528,
  cart1: 533,
  cart2: 541,
  dmPeek1: 547,
  dmPeek1End: 560,
  cart3: 565,
  cart4: 571,
  cart5: 577,
  dmPeek2: 583,
  dmPeek2End: 595,
  cart6: 601,
  cart7: 607,
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
  researchLoad: 762,
  praiseIn: 764,

  /* --------------------------------------------------------- S7 finish + wrap up (130f) */
  praiseOut: 788,
  switchToEditor6: 792,
  writeH3: 798,
  writeP12: 804,
  writeP13: 812,
  writeP14: 822,
  chartIn: 832,
  switchToBrowser6: 840,
  mailOpen: 846,
  sendClick: 858,
  mailSent: 864,
  popupOpen2: 868,
  endSessionClick: 878,
  summaryShown: 880,

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
 * Menu-bar clock. Absolute frame -> displayed time.
 *
 * Two spans have to read as real elapsed time: the research loop (2:00 → 3:02, the
 * "about an hour" of actual work) and the drift (3:04 → 3:30). The snooze at 3:15 and
 * nudge #3 at 3:29 are what make "벌써 14분째" literally true on screen.
 */
export const clockSteps: ReadonlyArray<{ from: number; label: string }> = [
  { from: 0, label: "오후 2:00" },
  { from: beat.newsEnter, label: "오후 2:04" },
  { from: beat.switchToEditor1, label: "오후 2:11" },
  { from: beat.statsEnter, label: "오후 2:26" },
  { from: beat.paste1, label: "오후 2:33" },
  { from: beat.cohortsEnter, label: "오후 2:41" },
  { from: beat.switchToEditor4, label: "오후 2:55" },
  { from: beat.writeP11, label: "오후 2:58" },
  { from: beat.enter2, label: "오후 3:02" },
  { from: beat.igEnter, label: "오후 3:04" },
  { from: beat.igDmEnter, label: "오후 3:06" },
  { from: beat.musicOpen, label: "오후 3:09" },
  { from: beat.nudge1In, label: "오후 3:11" },
  { from: beat.nudge2In, label: "오후 3:14" },
  { from: beat.snoozeClick, label: "오후 3:15" },
  { from: beat.shopEnter, label: "오후 3:18" },
  { from: beat.cart3, label: "오후 3:22" },
  { from: beat.cart6, label: "오후 3:26" },
  { from: beat.cartViewEnter, label: "오후 3:29" },
  { from: beat.returnToGoalTab, label: "오후 3:30" },
  { from: beat.praiseIn, label: "오후 3:31" },
  { from: beat.switchToEditor6, label: "오후 3:38" },
  { from: beat.mailOpen, label: "오후 3:52" },
  { from: beat.popupOpen2, label: "오후 3:55" },
];

export const clockAt = (frame: number): string => {
  let label = clockSteps[0].label;
  for (const step of clockSteps) if (frame >= step.from) label = step.label;
  return label;
};

export const seconds = (frames: number): number => frames / FPS;

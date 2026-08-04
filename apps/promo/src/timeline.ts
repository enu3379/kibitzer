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
  s1Setup: { from: 0, duration: 140 },
  /** Research loop — read, switch, write, copy, paste, repeat — then attention fades. */
  s2Research: { from: 140, duration: 406 },
  /** Drift #1 — direct messages, plus the music link that arrives inside them. */
  s3Messages: { from: 546, duration: 272 },
  /** Drift #2/#3 — portal → mall, interleaved with the messages piling up. */
  s4Shopping: { from: 818, duration: 286 },
  /** Everything stops. */
  s5Freeze: { from: 1104, duration: 72 },
  /** Clear the mess, look at the document, pick a new research thread. */
  s6Reset: { from: 1176, duration: 154 },
  /** Praise carries over, the report is finished, the mail goes out, session ends. */
  s7WrapUp: { from: 1330, duration: 222 },
  s8EndCard: { from: 1552, duration: 60 },
} as const;

export const TOTAL_FRAMES = scene.s8EndCard.from + scene.s8EndCard.duration; // 1612 ≈ 53.7s

/** How long the Cmd-Tab switcher stays up. */
export const SWITCHER_FRAMES = 9;

export const beat = {
  /* --------------------------------------------------------- S1 goal declaration */
  popupOpen: 32,
  goalTypeStart: 52,
  goalTypeEnd: 106,
  startClick: 122,
  popupClose: 136,

  /* --------------------------------------------------------- S2 the research loop
   * Three round trips between the browser and the writing app. Each trip is faster
   * than the last; the third one is where the copy-paste happens and where the
   * document visibly outgrows the page. Then it all decelerates.
   */
  newsEnter: 146,
  switchToEditor1: 182,
  writeH1: 192,
  writeP1: 214,

  switchToBrowser1: 258,
  statsEnter: 264,
  select1: 276,
  copy1: 290,
  switchToEditor2: 298,
  paste1: 308,
  writeH2: 320,
  writeP2: 342,

  switchToBrowser2: 380,
  newsReturn: 386,
  select2: 396,
  copy2: 408,
  switchToEditor3: 416,
  paste2: 426,
  /** Deliberately slower than the earlier blocks — the pace comes off the boil here. */
  writeP3: 438,
  enter1: 488,
  enter2: 496,
  /** 496 → 546: nothing on screen but a blinking caret. */

  /* --------------------------------------------------------- S3 drift #1: messages */
  switchToBrowser3: 546,
  newTabClick: 562,
  omniType: 572,
  omniSuggest: 580,
  omniTab: 590,
  igEnter: 598,
  igDmEnter: 626,
  dmReply1: 640,
  dmSwitch2: 660,
  dmReply2: 676,
  /** A third thread lights up mid-reply and wins. */
  dmInterrupt: 690,
  dmSwitch3: 698,
  musicLink: 714,
  musicOpen: 726,
  dmReturn: 752,
  dotRed1: 768,
  nudge1In: 774,
  nudge1Dismiss: 808,

  /* --------------------------------------------------------- S4 drift #2/#3: the mall */
  nudge2In: 828,
  snoozeClick: 864,
  portalEnter: 876,
  portalQuery: 882,
  /** The mall opens on its listing page; the pick happens after a scroll. */
  shopEnter: 910,
  shopPick: 942,
  cart1: 950,
  cart2: 964,
  dmPeek1: 976,
  dmPeek1End: 1000,
  cart3: 1008,
  cart4: 1018,
  cart5: 1028,
  dmPeek2: 1036,
  dmPeek2End: 1056,
  cart6: 1064,
  cart7: 1074,
  cartViewEnter: 1082,
  nudge3In: 1094,

  /* --------------------------------------------------------- S5 the stop */
  freezeStart: 1104,
  freezeEnd: 1152,

  /* --------------------------------------------------------- S6 clear + restart */
  closeTab1: 1184, // shop
  closeTab2: 1196, // portal
  closeTab3: 1208, // music
  closeTab4: 1220, // messages
  returnToGoalTab: 1234,
  /** Open the document once — long enough to see the empty line it was left on. */
  switchToEditor4: 1248,
  switchToBrowser4: 1290,
  newResearchTab: 1300,
  researchLoad: 1314,
  praiseIn: 1320,

  /* --------------------------------------------------------- S7 finish + wrap up */
  praiseOut: 1352,
  switchToEditor5: 1358,
  writeH3: 1370,
  writeP4: 1392,
  chartIn: 1434,
  switchToBrowser5: 1446,
  mailOpen: 1458,
  sendClick: 1486,
  mailSent: 1496,
  popupOpen2: 1504,
  endSessionClick: 1524,
  summaryShown: 1526,

  /* --------------------------------------------------------- S8 */
  endCardIn: 1552,
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
  { from: beat.switchToBrowser2, label: "오후 2:47" },
  { from: beat.paste2, label: "오후 2:55" },
  { from: beat.writeP3, label: "오후 2:58" },
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
  { from: beat.switchToEditor5, label: "오후 3:38" },
  { from: beat.mailOpen, label: "오후 3:52" },
  { from: beat.popupOpen2, label: "오후 3:55" },
];

export const clockAt = (frame: number): string => {
  let label = clockSteps[0].label;
  for (const step of clockSteps) if (frame >= step.from) label = step.label;
  return label;
};

export const seconds = (frames: number): number => frames / FPS;

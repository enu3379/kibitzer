/**
 * Single source of truth for every beat in the promo.
 *
 * Scenes are laid out back to back; every in-scene beat below is an ABSOLUTE frame on
 * the master timeline so that scene components, audio cues and the still-render script
 * can all point at the same number. Retiming the video means editing this file only.
 */
import { FPS } from "./theme";

export const scene = {
  s1Setup: { from: 0, duration: 140 },
  s2Focus: { from: 140, duration: 150 },
  s3Drift: { from: 290, duration: 140 },
  s4Escalate: { from: 430, duration: 230 },
  s5Return: { from: 660, duration: 120 },
  s6Praise: { from: 780, duration: 86 },
  s7WrapUp: { from: 866, duration: 106 },
  s8EndCard: { from: 972, duration: 58 },
} as const;

export const TOTAL_FRAMES = scene.s8EndCard.from + scene.s8EndCard.duration; // 1030 ≈ 34.3s

/** How long the Cmd-Tab switcher stays up. */
export const SWITCHER_FRAMES = 9;

export const beat = {
  // S1 — goal declaration (browser)
  popupOpen: 32,
  goalTypeStart: 52,
  goalTypeEnd: 106,
  startClick: 122,
  popupClose: 136,

  // S2 — put music on, read, check the numbers, then switch to the writing app
  musicView: 140,
  newsEnter: 166,
  statsEnter: 208,
  switchToEditor1: 228,
  outlineTypeStart: 238,
  outlineTypeEnd: 287,

  // S3 — drift #1: direct messages.
  // Every beat here must sit at or after scene.s3Drift.from, or s3() never runs it.
  switchToBrowser1: 292,
  igEnter: 308,
  igDmEnter: 340,
  dotRed1: 362,
  nudge1In: 368,
  nudge1Dismiss: 414,

  // S4 — snooze, then drift #2/#3: portal → mall, with the cart as the clock
  nudge2In: 434,
  snoozeClick: 480,
  montageStart: 488,
  portalEnter: 488,
  shopEnter: 516,
  cartViewEnter: 588,
  montageEnd: 606,
  nudge3In: 612,

  // S5 — the awakening
  freezeStart: 660,
  freezeEnd: 692,
  closeTab1: 708,
  closeTab2: 722,
  closeTab3: 736,
  returnToGoalTab: 752,

  // S6 — praise (in the browser, on a goal-related tab), then back to writing
  praiseIn: 782,
  praiseOut: 820,
  switchToEditor2: 824,
  resumeTypeStart: 836,
  resumeTypeEnd: 856,

  // S7 — wrap-up: finish, switch back, send, end the session
  switchToBrowser2: 882,
  mailOpen: 894,
  sendClick: 918,
  mailSent: 928,
  popupOpen2: 934,
  endSessionClick: 950,
  summaryShown: 952,

  // S8
  endCardIn: 972,
} as const;

/** Audio cues — file + absolute frame of the visual it must land on. */
export const sfx = [
  { file: "sfx/ding.wav", at: beat.nudge1In },
  { file: "sfx/ding.wav", at: beat.nudge2In },
  { file: "sfx/ding.wav", at: beat.nudge3In },
  { file: "sfx/celebrate.wav", at: beat.praiseIn },
] as const;

/**
 * Menu-bar clock. Absolute frame -> displayed time. The jump across the montage is the
 * main "time really passed" signal, so these thresholds are deliberate, not derived.
 */
export const clockSteps: ReadonlyArray<{ from: number; label: string }> = [
  { from: 0, label: "오후 2:00" },
  { from: scene.s2Focus.from, label: "오후 2:01" },
  { from: beat.igEnter, label: "오후 2:03" },
  { from: beat.nudge2In, label: "오후 2:05" },
  { from: beat.montageStart, label: "오후 2:07" },
  { from: beat.shopEnter, label: "오후 2:09" },
  { from: beat.shopEnter + 44, label: "오후 2:12" },
  { from: beat.cartViewEnter, label: "오후 2:14" },
  { from: beat.freezeStart, label: "오후 2:15" },
  { from: beat.praiseIn, label: "오후 2:16" },
  { from: scene.s7WrapUp.from, label: "오후 2:48" },
  { from: beat.popupOpen2, label: "오후 2:52" },
];

export const clockAt = (frame: number): string => {
  let label = clockSteps[0].label;
  for (const step of clockSteps) if (frame >= step.from) label = step.label;
  return label;
};

export const seconds = (frames: number): number => frames / FPS;

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
  s2Focus: { from: 140, duration: 140 },
  s3Drift: { from: 280, duration: 140 },
  s4Escalate: { from: 420, duration: 230 },
  s5Return: { from: 650, duration: 130 },
  s6Praise: { from: 780, duration: 90 },
  s7WrapUp: { from: 870, duration: 110 },
  s8EndCard: { from: 980, duration: 60 },
} as const;

export const TOTAL_FRAMES = scene.s8EndCard.from + scene.s8EndCard.duration; // 1040 ≈ 34.7s

/** How long the Cmd-Tab switcher stays up. */
export const SWITCHER_FRAMES = 9;

export const beat = {
  // S1 — goal declaration (browser)
  popupOpen: 32,
  goalTypeStart: 52,
  goalTypeEnd: 106,
  startClick: 122,
  popupClose: 136,

  // S2 — focused work: read, check the numbers, then switch to the writing app
  newsEnter: 140,
  statsEnter: 186,
  switchToEditor1: 206,
  outlineTypeStart: 216,
  outlineTypeEnd: 277,

  // S3 — first drift: back to the browser, then away from the goal.
  // Every beat here must sit at or after scene.s3Drift.from, or s3() never runs it.
  switchToBrowser1: 282,
  tubeEnter: 298,
  dotRed1: 330,
  nudge1In: 336,
  nudge1Dismiss: 384,
  tubeSecondVideo: 394,

  // S4 — snooze + time-lapse
  nudge2In: 424,
  snoozeClick: 470,
  montageStart: 478,
  montageEnd: 596,
  nudge3In: 602,

  // S5 — the awakening
  freezeStart: 650,
  freezeEnd: 682,
  closeTab1: 698,
  closeTab2: 712,
  closeTab3: 726,
  returnToGoalTab: 742,

  // S6 — praise (in the browser, on a goal-related tab), then back to writing
  praiseIn: 782,
  praiseOut: 824,
  switchToEditor2: 828,
  resumeTypeStart: 840,
  resumeTypeEnd: 864,

  // S7 — wrap-up: finish, switch back, send, end the session
  switchToBrowser2: 886,
  mailOpen: 898,
  sendClick: 922,
  mailSent: 932,
  popupOpen2: 938,
  endSessionClick: 954,
  summaryShown: 956,

  // S8
  endCardIn: 980,
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
  { from: beat.tubeEnter, label: "오후 2:03" },
  { from: beat.nudge2In, label: "오후 2:05" },
  { from: beat.montageStart, label: "오후 2:07" },
  { from: beat.montageStart + 40, label: "오후 2:09" },
  { from: beat.montageStart + 78, label: "오후 2:12" },
  { from: beat.nudge3In - 6, label: "오후 2:14" },
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

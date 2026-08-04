import { Easing, interpolate } from "remotion";

/** Clamped interpolation — the default for every transition in this project. */
export const range = (
  frame: number,
  [inA, inB]: [number, number],
  [outA, outB]: [number, number],
  easing = Easing.out(Easing.cubic),
): number =>
  interpolate(frame, [inA, inB], [outA, outB], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

/** 0→1 progress over [from, from+len). */
export const progress = (frame: number, from: number, len: number, easing?: (n: number) => number): number =>
  range(frame, [from, from + len], [0, 1], easing ?? Easing.out(Easing.cubic));

/** The toast entrance curve from toastOverlay.ts: cubic-bezier(.2, .8, .3, 1). */
export const toastEase = Easing.bezier(0.2, 0.8, 0.3, 1);

/** The celebration hop from toastOverlay.ts: cubic-bezier(.34, 1.56, .64, 1). */
export const springEase = Easing.bezier(0.34, 1.56, 0.64, 1);

/** Fade in then out, with hold. Returns opacity. */
export const fadeInOut = (frame: number, from: number, inLen: number, holdLen: number, outLen: number): number => {
  if (frame < from) return 0;
  const rise = range(frame, [from, from + inLen], [0, 1]);
  const fall = range(frame, [from + inLen + holdLen, from + inLen + holdLen + outLen], [1, 0]);
  return Math.min(rise, fall);
};

/** True while `frame` sits inside [from, to). */
export const between = (frame: number, from: number, to: number): boolean => frame >= from && frame < to;

/** Snap a 0→1 progress onto `steps` discrete stops (used for the montage video swaps). */
export const stepIndex = (p: number, steps: number): number => Math.min(steps - 1, Math.floor(p * steps));

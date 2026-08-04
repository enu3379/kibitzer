import { Easing } from "remotion";
import { range } from "./anim";

export type Waypoint = {
  /** Absolute frame at which the cursor arrives at this point. */
  frame: number;
  x: number;
  y: number;
  /** Fire a click ring on arrival. */
  click?: boolean;
  /** Hidden until this waypoint's frame (used when the cursor leaves the stage). */
  hidden?: boolean;
};

export type CursorState = {
  x: number;
  y: number;
  visible: boolean;
  /** 0→1 over the 10 frames after a click, drives the expanding ring. */
  clickAge: number | null;
  pressed: boolean;
};

const CLICK_RING_FRAMES = 10;

/**
 * Interpolates a cursor along an ordered waypoint list. Movement eases in and out so the
 * pointer reads as a hand rather than a linear tween; clicks emit a short ring.
 */
export const cursorAt = (frame: number, path: readonly Waypoint[]): CursorState => {
  if (path.length === 0) return { x: 0, y: 0, visible: false, clickAge: null, pressed: false };

  let prev = path[0];
  let next = path[0];
  for (let i = 0; i < path.length; i += 1) {
    if (path[i].frame <= frame) {
      prev = path[i];
      next = path[Math.min(i + 1, path.length - 1)];
    }
  }
  if (frame < path[0].frame) {
    prev = path[0];
    next = path[0];
  }

  const x = prev === next ? prev.x : range(frame, [prev.frame, next.frame], [prev.x, next.x], Easing.inOut(Easing.cubic));
  const y = prev === next ? prev.y : range(frame, [prev.frame, next.frame], [prev.y, next.y], Easing.inOut(Easing.cubic));

  let clickAge: number | null = null;
  let pressed = false;
  for (const wp of path) {
    if (!wp.click) continue;
    const age = frame - wp.frame;
    if (age >= 0 && age < CLICK_RING_FRAMES) {
      clickAge = age / CLICK_RING_FRAMES;
      pressed = age < 4;
    }
  }

  return { x, y, visible: !prev.hidden, clickAge, pressed };
};

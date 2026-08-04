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
 * How long the pointer takes to cross `d` logical pixels — roughly Fitts, deliberately fast.
 *
 * The old model spread every move across the whole gap between two waypoints, which made
 * the pointer the slowest thing on a screen whose clock is spinning through quarter hours:
 * a hand drifting for a second and a half towards a button while fifteen minutes go by
 * behind it. A hand does not do that. It waits, darts, and lands.
 *
 * So a move is scheduled to ARRIVE on its waypoint frame rather than to start on the
 * previous one: the pointer parks, then takes this many frames to get there. Clicks stay
 * pinned to their beats, and stretching a cut no longer stretches the pointer with it.
 * Eight frames for a nudge across a card, seventeen for a corner-to-corner crossing.
 */
const travelFrames = (d: number): number => Math.min(17, 4.5 + Math.sqrt(d) * 0.36);

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

  // Park on `prev`, then cross to `next` over the last `travel` frames of the gap.
  const dist = Math.hypot(next.x - prev.x, next.y - prev.y);
  const travel = Math.min(next.frame - prev.frame, travelFrames(dist));
  const depart = next.frame - travel;
  const still = prev === next || travel <= 0 || frame <= depart;

  const x = still ? prev.x : range(frame, [depart, next.frame], [prev.x, next.x], Easing.inOut(Easing.cubic));
  const y = still ? prev.y : range(frame, [depart, next.frame], [prev.y, next.y], Easing.inOut(Easing.cubic));

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

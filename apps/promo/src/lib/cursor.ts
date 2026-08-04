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
 * Deterministic pseudo-noise in [0,1).
 *
 * Every wobble below is seeded off the waypoint it belongs to rather than drawn at render
 * time. Remotion renders frames concurrently and re-renders them on retry, so a `Math.random`
 * anywhere in this file would give the same frame a different pointer position depending on
 * which worker drew it — the classic way a "human-like" mouse ends up jittering like a
 * dropped frame. The hash is the usual GLSL one; only its spread matters, not its quality.
 */
const noise = (seed: number): number => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Minimum jerk — the position profile a reaching arm actually follows.
 *
 * 10t³ − 15t⁴ + 6t⁵ is the closed form of the trajectory that minimises jerk over a fixed
 * duration, and it is the standard model for human point-to-point movement. Against the
 * cubic ease it replaces it leaves slower, softer and more symmetric: zero velocity AND
 * zero acceleration at both ends, so the pointer neither starts with a snap nor arrives
 * with one. This is the single biggest reason the old pointer read as a tween.
 */
const minJerk = (t: number): number => t * t * t * (10 + t * (6 * t - 15));

/**
 * The second submovement.
 *
 * A hand does not reach a small target in one go. It throws the pointer at it open-loop —
 * fast, and a few percent off — and then closes the last stretch in a short corrective
 * movement under visual feedback. That is Woodworth's two-component model, and it is what
 * every "make the mouse look human" recipe is approximating when it talks about overshoot.
 *
 * So the ballistic phase owns 72% of the travel time and covers `gain` of the distance,
 * where gain is seeded per move and straddles 1: over it, the pointer sails past the target
 * and comes back; under it, it stops short and creeps in. The correction then spends the
 * remaining time on whatever is left, which is why it reads as slow even though it is four
 * or five frames. Short moves skip all this — the correction only shows up when the throw
 * is long enough to miss.
 */
const BALLISTIC = 0.72;
const CORRECTED_ABOVE = 110;

const advance = (t: number, gain: number): number =>
  t <= BALLISTIC
    ? gain * minJerk(t / BALLISTIC)
    : gain + (1 - gain) * minJerk((t - BALLISTIC) / (1 - BALLISTIC));

/**
 * Curvature. Nobody moves a mouse in a straight line: the elbow and wrist rotate, so the
 * path bows, and which way it bows depends on where the hand is coming from. Modelled as a
 * quadratic Bézier whose control point is pushed off the midpoint at a right angle to the
 * travel, by 3–9% of the distance, sign and size seeded per move. A Bézier is exact at both
 * ends — B(0) = from and B(1) = to — so bowing the path cannot move a click off its button.
 */
const BOW = { min: 0.03, max: 0.09 } as const;

/**
 * Tremor. A hand holding a mouse through a fast movement is not steady, and a pointer that
 * is perfectly steady is the tell. A couple of tenths of a pixel, perpendicular to travel,
 * enveloped by 4t(1−t) so it is strongest at peak speed and exactly zero at both ends —
 * which again keeps the arrival frame exact.
 */
const TREMOR = 0.9;

/**
 * Settle. The pixel or two a hand gives back in the moment after it lands, and then stops.
 *
 * Enveloped by a half sine over 18 frames: zero on the arrival frame itself (so a click is
 * still dead on its hit point), a peak a few frames later, zero again well before any long
 * park is over. That last part is deliberate — the freeze in S5 holds the pointer for 36
 * frames and has to be genuinely motionless, so this cannot be a drift that never ends.
 */
const SETTLE = { frames: 18, px: 0.8 } as const;

/**
 * Interpolates a cursor along an ordered waypoint list.
 *
 * The shape of a single move: park on `prev`, then cross to `next` over the last `travel`
 * frames before it, along a bowed path, at a minimum-jerk rate, with a corrective
 * submovement at the end if the throw was long, plus tremor while it is moving and a settle
 * once it has landed. Everything except the first two is an offset that vanishes at t = 0
 * and t = 1, so waypoints — and therefore clicks — remain exact.
 */
export const cursorAt = (frame: number, path: readonly Waypoint[]): CursorState => {
  if (path.length === 0) return { x: 0, y: 0, visible: false, clickAge: null, pressed: false };

  let prev = path[0];
  let next = path[0];
  let idx = 0;
  for (let i = 0; i < path.length; i += 1) {
    if (path[i].frame <= frame) {
      prev = path[i];
      next = path[Math.min(i + 1, path.length - 1)];
      idx = i;
    }
  }
  if (frame < path[0].frame) {
    prev = path[0];
    next = path[0];
  }

  // Park on `prev`, then cross to `next` over the last `travel` frames of the gap.
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const travel = Math.min(next.frame - prev.frame, travelFrames(dist));
  const depart = next.frame - travel;
  const still = prev === next || travel <= 0 || frame <= depart;

  // One seed per move, so the same crossing bows the same way on every render.
  const seed = next.frame * 7.13 + idx * 3.7;

  let x = prev.x;
  let y = prev.y;

  if (still) {
    // Settling after the last arrival — a half sine that is zero the moment it lands.
    const age = frame - prev.frame;
    if (age > 0 && age < SETTLE.frames) {
      const env = Math.sin((Math.PI * age) / SETTLE.frames) * SETTLE.px;
      x += (noise(seed + 11) * 2 - 1) * env;
      y += (noise(seed + 17) * 2 - 1) * env;
    }
  } else {
    const t = Math.min(1, Math.max(0, (frame - depart) / travel));
    const gain = dist > CORRECTED_ABOVE ? 1 + (noise(seed) * 2 - 1) * 0.06 : 1;
    const s = advance(t, gain);

    // Bowed path. `s` may run just past 1 during an overshoot, and the Bézier carries on
    // along its own tangent there, which is exactly what an overshoot looks like.
    const bow = (BOW.min + noise(seed + 3) * (BOW.max - BOW.min)) * (noise(seed + 5) < 0.5 ? -1 : 1) * dist;
    const nx = dist === 0 ? 0 : -dy / dist;
    const ny = dist === 0 ? 0 : dx / dist;
    const cx = prev.x + dx / 2 + nx * bow;
    const cy = prev.y + dy / 2 + ny * bow;
    const u = 1 - s;
    x = u * u * prev.x + 2 * u * s * cx + s * s * next.x;
    y = u * u * prev.y + 2 * u * s * cy + s * s * next.y;

    const tremor = 4 * t * (1 - t) * TREMOR * (0.4 + noise(seed + 7) * 0.6);
    const wobble = Math.sin(frame * 1.9 + noise(seed + 9) * Math.PI * 2) * tremor;
    x += nx * wobble;
    y += ny * wobble;
  }

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

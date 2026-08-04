/**
 * Keystroke and click cues, derived from the same numbers that draw them.
 *
 * The nudge and praise sounds are authored — four cues, pinned by hand in `timeline.ts`.
 * Input sounds cannot work that way: there are several hundred of them and every one is a
 * consequence of a `typed()` call or a `click: true` waypoint. Listing them separately
 * would mean a retime silently desynchronises the audio from the picture, which is the
 * one failure this file exists to make impossible. So a run of typing declares the same
 * three values it hands to `typed()` — start frame, text, frames per character — and the
 * cue list falls out of it.
 *
 * MIN_GAP is the only judgement here. The document's on-camera paragraphs are fitted to
 * their beats and land as fast as 0.1 frames per character, i.e. ten keys a frame; one
 * sample per character there is not typing, it is white noise. Thinning to one click
 * every other frame caps the rate at fifteen a second — fast enough to read as a flurry,
 * slow enough that the individual strikes are still audible. A paragraph that appears in
 * four frames therefore gets two clicks, which is the honest amount of sound for
 * something that takes an eighth of a second.
 */

import { Waypoint } from "./cursor";

export type TypingRun = {
  /** The `from` handed to `typed()` — character k lands on frame `from + k * fpc`. */
  from: number;
  text: string;
  /** Frames per character, as handed to `typed()`. */
  fpc: number;
  /**
   * Frame the text stops being on screen, if it goes before the run finishes.
   *
   * `typed()` keeps advancing whether or not anything is drawing it, and three places in
   * the film take the surface away mid-run: the goal field when 시작 is pressed, the
   * address bar when the page loads under it, and the writing app whenever a Cmd-Tab puts
   * the browser in front of it. Without this the mix carries keys being pressed into
   * something that is not there.
   */
  until?: number;
  /** Multiplier on the base level, for a run that should sit further back. */
  gain?: number;
};

/** A single named key: Enter, Tab, ⌘V — anything the film shows as one press. */
export type KeyPress = { at: number; gain?: number };

export type SfxCue = { at: number; file: string; volume: number };

const KEY_FILES = ["sfx/key-1.wav", "sfx/key-2.wav", "sfx/key-3.wav", "sfx/key-4.wav"];
/** Space, Enter, Tab and the modifiers — a bigger key, not the same key played louder. */
const WIDE_FILE = "sfx/key-wide.wav";
const CLICK_FILES = ["sfx/click-1.wav", "sfx/click-2.wav"];

/**
 * How close together two strikes may fall — the density knob, and the one `driveAt`
 * turns. Steps rather than a ramp, because a cue frame is an integer and the achievable
 * rates are therefore 30/n keys a second and nothing in between: a minimum gap of 1.03
 * frames does not mean "just under thirty", it means fifteen, because the next candidate
 * one frame later fails the test. Interpolating the gap continuously produced a curve
 * that read as a ramp in the source and as a hard cliff in the mix. So the tiers are
 * written out, and each one is a rate somebody can actually hear the difference between.
 *
 * Enforced across the whole keyboard rather than within each run, which is not a detail:
 * adjacent runs share a boundary frame by construction — a document block starts on the
 * frame the one before it finishes, and each reply in the messages app starts on the
 * frame the previous bubble lands. Thinning per run leaves both strikes standing, and two
 * samples on one frame is 6 dB of keyboard where a single key was pressed. That is how
 * typing ended up as loud as the nudge.
 */
const GAP_TIERS: ReadonlyArray<readonly [minDrive: number, gap: number]> = [
  [0.85, 1], // 30/s — the top of the research parabola, and nowhere else
  [0.55, 2], // 15/s — working, and the messages once the thread takes over
  [0.3, 3], //  10/s — declaring the goal, clearing up, winding down
  [0, 4], //   7.5/s — the paragraph where the momentum runs out
];

const gapFor = (drive: number): number => GAP_TIERS.find(([min]) => drive >= min)?.[1] ?? 4;

/** How much of the level the drive curve owns. 1 is the ceiling measured against it. */
const DRIVE_FLOOR = 0.8;
const CLICK_DRIVE_FLOOR = 0.82;

/** Reads `driveAt` from timeline.ts. Passed in so this file stays a pure function. */
export type DriveAt = (frame: number) => number;

/**
 * Levels, and the only two numbers worth turning.
 *
 * The brief is a ratio: a keystroke stays under 60% of the nudge. `make-input-sfx.mjs`
 * normalises every shipped sample to one peak so these constants mean the same thing
 * whichever style was baked, but the ratio still cannot be read off the files — Remotion
 * resamples 44.1k to 48k and a sharp transient does not survive that at its nominal
 * height. ding.wav loses about 3 dB on the way in; a keystroke gains about 1. So the
 * ratio is measured off an audio-only render instead, which takes about a minute:
 *
 *   npx remotion render KibitzerPromo out/mix.wav
 *
 * The ceiling is on the LOUDEST keystroke in the film, which is not one sample: at the
 * top of the research parabola strikes land a frame apart and their tails sum, so the
 * densest stretch runs about 12% hotter than a single key. Setting these against a lone
 * hit put that stretch at 63% of the nudge. They are set against the measured maximum
 * instead, which is what the brief is actually about.
 *
 * At these values the nudge peaks at -16.3 dBFS, the loudest keystroke at -21.6 (54% of
 * it) and the loudest click at -20.9 (58%, in the middle of the spree, which is where a
 * click should be at its most insistent). Re-measure after changing either number, after
 * moving the drive curve, or after rebaking the samples.
 */
const KEY_LEVEL = 0.075;
const CLICK_LEVEL = 0.15;

/** Frames to hold each cue's Sequence open — longer than the longest sample. */
export const SFX_FRAMES = 8;

/** Deterministic per-cue jitter. Math.random() would reshuffle the mix on every render. */
const hash = (n: number): number => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

/** ±13%, so a repeated file never sounds like the same file. */
const jitter = (h: number): number => 0.87 + ((h >>> 8) % 128) / 490;

/**
 * Every strike the keyboard makes, in one pass.
 *
 * Runs and named presses are thinned together because they are one pair of hands: a run
 * and the Enter that ends it, or two runs that share a boundary frame, would otherwise
 * both fire. Presses sort first at equal frames and so survive the thinning — a key the
 * film has put a chip on screen for is authored, and a derived keystroke is not allowed
 * to displace it.
 */
export const keyboardCues = (
  runs: readonly TypingRun[],
  presses: readonly KeyPress[],
  driveAt: DriveAt,
): SfxCue[] => {
  const candidates: Array<SfxCue & { rank: number }> = presses.map((p) => ({
    at: Math.round(p.at),
    file: WIDE_FILE,
    volume: KEY_LEVEL * (p.gain ?? 1.15),
    rank: 0,
  }));

  runs.forEach((run, r) => {
    Array.from(run.text).forEach((c, i) => {
      const at = Math.ceil(run.from + (i + 1) * run.fpc);
      if (run.until !== undefined && at > run.until) return;
      const h = hash(r * 8191 + i);
      candidates.push({
        at,
        file: c === " " ? WIDE_FILE : KEY_FILES[h % KEY_FILES.length],
        volume: KEY_LEVEL * (run.gain ?? 1) * jitter(h),
        rank: 1,
      });
    });
  });

  candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);

  const cues: SfxCue[] = [];
  let last = -Infinity;
  for (const c of candidates) {
    const drive = driveAt(c.at);
    if (c.at - last < gapFor(drive)) continue;
    last = c.at;
    cues.push({ at: c.at, file: c.file, volume: c.volume * (DRIVE_FLOOR + (1 - DRIVE_FLOOR) * drive) });
  }
  return cues;
};

/**
 * One click per `click: true` waypoint — the same flag that draws the ring, so a pointer
 * beat that moves takes its sound with it. Drag-selects are deliberately silent: they are
 * a press and a release seconds apart, and a click sample would misdescribe them.
 */
/**
 * The two tracks, merged.
 *
 * A keystroke that lands on the same frame as a click is dropped. One pair of hands does
 * not press a key and click a mouse inside the same 33 ms, and the mix agrees: at
 * `searchEnter3` the Enter that submits the query and the pointer landing on the tab were
 * both firing on frame 197, and the two summing was the single loudest keyboard moment in
 * the film — 66% of the nudge, over the ceiling, on a frame where only one thing actually
 * happened. The click keeps the frame because it is authored: it has a ring drawn on it.
 */
export const mergeInput = (keys: readonly SfxCue[], clicks: readonly SfxCue[]): SfxCue[] => {
  const taken = new Set(clicks.map((c) => c.at));
  return [...keys.filter((k) => !taken.has(k.at)), ...clicks].sort((a, b) => a.at - b.at);
};

export const clickCues = (path: readonly Waypoint[], driveAt: DriveAt): SfxCue[] =>
  path
    .filter((w) => w.click)
    .map((w, i) => {
      const h = hash(i * 65537);
      const drive = driveAt(w.frame);
      return {
        at: w.frame,
        file: CLICK_FILES[h % CLICK_FILES.length],
        volume: CLICK_LEVEL * jitter(h) * (CLICK_DRIVE_FLOOR + (1 - CLICK_DRIVE_FLOOR) * drive),
      };
    });

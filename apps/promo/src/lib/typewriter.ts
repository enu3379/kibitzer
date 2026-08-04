/**
 * Character-wise reveal. Uses Array.from so that Hangul syllables (and any surrogate
 * pairs) are never split mid-codepoint — slicing by .length would corrupt them.
 */
export const typed = (text: string, frame: number, from: number, framesPerChar = 2): string => {
  const chars = Array.from(text);
  if (frame <= from) return "";
  const shown = Math.floor((frame - from) / framesPerChar);
  return chars.slice(0, Math.max(0, Math.min(chars.length, shown))).join("");
};

/** Frame at which `text` finishes typing. */
export const typedEnd = (text: string, from: number, framesPerChar = 2): number =>
  from + Array.from(text).length * framesPerChar;

/** Blinking caret, ~0.53s period like a real text field. */
export const caretOn = (frame: number): boolean => Math.floor(frame / 16) % 2 === 0;

/** Types a list of lines one after another; returns the lines revealed so far. */
export const typedLines = (lines: readonly string[], frame: number, from: number, framesPerChar = 2): string[] => {
  const out: string[] = [];
  let cursor = from;
  for (const line of lines) {
    const end = typedEnd(line, cursor, framesPerChar);
    if (frame <= cursor) break;
    out.push(typed(line, frame, cursor, framesPerChar));
    if (frame < end) break;
    cursor = end + 6; // small pause between lines
  }
  return out;
};

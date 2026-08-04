/**
 * Page layout for the writing app.
 *
 * The document is the one thing in this video that has to look like *work*, so it is laid
 * out like a real word processor: fixed-size sheets with a grey gutter between them, a
 * page counter, a character count. "Five pages written" is then something the viewer can
 * literally read off the screen instead of inferring from a scrollbar.
 *
 * The metrics below are set for density rather than comfort — 11.5px on 1.62, justified,
 * ~37 lines to a page. A report that is meant to read as an afternoon of work cannot be
 * set like a blog post.
 *
 * Heights are estimated, not measured — Remotion renders deterministically, so a single
 * conservative model here keeps the scroll position, the page breaks and the status bar
 * in agreement without anyone reading back from the DOM.
 */
import { DocBlock } from "../copy";

/** Sheet geometry. 560 wide at A4 proportions (297/210) makes a page 792 tall. */
export const PAGE = {
  width: 560,
  height: 792,
  padX: 54,
  padY: 40,
  /** Grey gutter between two sheets. */
  gap: 18,
} as const;

/** The writing app's window rect, in logical px. */
export const EDITOR_RECT = { x: 88, y: 68, width: 930, height: 742 } as const;

export const EDITOR = {
  titlebar: 38,
  toolbar: 34,
  status: 26,
  /** Grey margin above the first sheet. */
  sheetTop: 16,
} as const;

/** Height of the sheet stack visible at once. */
export const DOC_VIEW =
  EDITOR_RECT.height - EDITOR.titlebar - EDITOR.toolbar - EDITOR.status - EDITOR.sheetTop; // 628

/** Title + subtitle + the rule under them, which only the first page carries. */
export const DOC_HEAD = 72;

/** Text height one page can hold. */
const CAPACITY = PAGE.height - PAGE.padY * 2; // 712

/**
 * Characters per line, used to guess how tall a paragraph lays out.
 *
 * Measured off the rendered stills: at the old 12.5px body size the 452px column took
 * ~48–50 characters of mixed Hangul, spaces and figures, and 46 was the conservative
 * number in use. Body type is now 11.5px with -0.1px tracking, and a re-measure off the
 * new render puts a full line at 54–55 characters. 52 keeps a line of margin over a long
 * paragraph and leaves room for `word-break: keep-all`, which hands a line back whenever
 * the next word will not fit. Err high rather than low — a paragraph estimated a line too
 * tall only leaves white space above a page break, while one estimated too short would
 * push text off the bottom of a fixed-height sheet. Err *too* high and every page breaks
 * early, which is what a dense report must not look like.
 */
const CHARS_PER_LINE = 52;
/** 11.5px × 1.62. A page therefore holds ~37 lines, which is about what an A4 page holds. */
const LINE_H = 19;
/** Enumerated items are inset, so they lose a few characters a line. */
const LIST_CHARS_PER_LINE = 46;
/**
 * The bibliography is set at 9.5px and mixes scripts within a single entry — an English
 * title followed by a Korean gloss. One character constant cannot describe both: a Hangul
 * glyph is ~7.8px wide at that size and a Latin one ~4.9px, so an all-Latin entry fits
 * nearly twice as much as a Korean one. `refLines` measures in Latin widths and counts a
 * Hangul character as 1.6 of them.
 */
const REF_UNITS_PER_LINE = 96;
const REF_LINE_H = 15;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const linesAt = (text: string, per: number): number =>
  Math.max(1, Math.ceil(Array.from(text).length / per));
const lines = (text: string): number => linesAt(text, CHARS_PER_LINE);
const refLines = (text: string): number => {
  const units = Array.from(text).reduce((n, c) => n + (HANGUL.test(c) ? 1.6 : 1), 0);
  return Math.max(1, Math.ceil(units / REF_UNITS_PER_LINE));
};

/** Laid-out height of a block, matching the styles in EditorMock. */
export const blockH = (b: DocBlock): number => {
  switch (b.t) {
    case "h":
      // marginTop + line box + marginBottom, for a section head and a sub-head.
      return b.level === 2 ? 31 : 40;
    case "p":
      return 5 + lines(b.text) * LINE_H;
    case "list":
      return 7 + b.items.reduce((h, it) => h + linesAt(it, LIST_CHARS_PER_LINE) * LINE_H + 2, 0);
    case "quote":
      return 51 + b.text.split("\n").length * 17;
    case "gap":
      return LINE_H;
    case "chart":
      return 149;
    case "refs":
      return 42 + b.items.reduce((h, it) => h + refLines(it) * REF_LINE_H + 3, 0);
  }
};

/** Characters a block contributes to the status bar's count. */
const blockChars = (b: DocBlock): number => {
  switch (b.t) {
    case "h":
    case "p":
    case "quote":
      return Array.from(b.text).length;
    case "list":
      return b.items.reduce((n, it) => n + Array.from(it).length, 0);
    case "refs":
      return b.items.reduce((n, it) => n + Array.from(it).length, Array.from(b.title).length);
    default:
      return 0;
  }
};

export type LaidOutPage = {
  blocks: DocBlock[];
  /** Index of this page's first block in the whole document. */
  from: number;
};

export type DocLayout = {
  pages: LaidOutPage[];
  /** Baseline of the last block, measured from the top of the first sheet. */
  caretY: number;
  /** 1-based page the caret sits on. */
  caretPage: number;
  chars: number;
};

/**
 * Break the document into pages. A block never straddles a break — it moves whole to the
 * next sheet, which is both what "keep lines together" does in a word processor and what
 * keeps the estimate above from ever clipping text.
 */
export const layout = (blocks: readonly DocBlock[]): DocLayout => {
  const pages: LaidOutPage[] = [{ blocks: [], from: 0 }];
  let used = DOC_HEAD;
  let caretY = PAGE.padY + DOC_HEAD;
  let chars = 0;

  blocks.forEach((b, i) => {
    const h = blockH(b);
    let page = pages[pages.length - 1];
    if (page.blocks.length > 0 && used + h > CAPACITY) {
      pages.push({ blocks: [], from: i });
      page = pages[pages.length - 1];
      used = 0;
    }
    page.blocks.push(b);
    caretY = (pages.length - 1) * (PAGE.height + PAGE.gap) + PAGE.padY + used + h;
    used += h;
    chars += blockChars(b);
  });

  return { pages, caretY, caretPage: pages.length, chars };
};

/** Scroll offset that keeps the caret near the bottom of the view. */
export const scrollFor = (caretY: number): number => Math.max(0, caretY + 40 - DOC_VIEW);

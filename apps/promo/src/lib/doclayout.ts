/**
 * Page layout for the writing app.
 *
 * The document is the one thing in this video that has to look like *work*, so it is laid
 * out like a real word processor: fixed-size sheets with a grey gutter between them, a
 * page counter, a character count. "Two or three pages written" is then something the
 * viewer can literally read off the screen instead of inferring from a scrollbar.
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

/** Title + subtitle, which only the first page carries. */
export const DOC_HEAD = 70;

/** Text height one page can hold. */
const CAPACITY = PAGE.height - PAGE.padY * 2; // 712

/**
 * Characters per line, used to guess how tall a paragraph lays out.
 *
 * Measured off the rendered stills: the 452px column takes ~48–50 characters of mixed
 * Hangul, spaces and figures. 46 leaves a little room for `word-break: keep-all`, which
 * hands a line back whenever the next word will not fit. Err high rather than low — a
 * paragraph estimated a line too tall only leaves white space above a page break, while
 * one estimated too short would push text off the bottom of a fixed-height sheet.
 */
const CHARS_PER_LINE = 46;
const LINE_H = 24;

const lines = (text: string): number => Math.max(1, Math.ceil(Array.from(text).length / CHARS_PER_LINE));

/** Laid-out height of a block, matching the styles in EditorMock. */
export const blockH = (b: DocBlock): number => {
  switch (b.t) {
    case "h":
      return 38;
    case "p":
      return 4 + lines(b.text) * LINE_H;
    case "quote":
      return 59 + b.text.split("\n").length * 20;
    case "gap":
      return 24;
    case "chart":
      return 163;
  }
};

/** Characters a block contributes to the status bar's count. */
const blockChars = (b: DocBlock): number =>
  b.t === "h" || b.t === "p" || b.t === "quote" ? Array.from(b.text).length : 0;

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

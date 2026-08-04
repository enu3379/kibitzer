/**
 * Where the report's page breaks fall, and how much of each page is used.
 *
 *   node scripts/doc-pages.mjs
 *
 * `src/lib/doclayout.ts` paginates from an *estimate* of how tall each block lays out,
 * because nothing reads back from the DOM. Two page breaks in the film are dramatic
 * beats rather than accidents — the document has to be full when attention wanders, and
 * the caret has to be left alone on a fresh page — so after any edit to the report copy
 * this prints the free space on every page and says whether those two still hold.
 * Rendering a still to find out costs a bundle; this costs a second.
 *
 * The document order is `Object.keys(report.blocks)`, which copy.ts keeps in sync with
 * the WRITING schedule in src/scenes/script.ts.
 */
import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const load = async (rel) => {
  const out = buildSync({
    entryPoints: [path.join(root, rel)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};

const { report } = await load("src/copy.ts");
const { PAGE, blockH, layout } = await load("src/lib/doclayout.ts");

const CAPACITY = PAGE.height - PAGE.padY * 2;
const keys = Object.keys(report.blocks);
const GAP = { t: "gap" };

/** The two Enters that end the writing session, and everything written before them. */
const ABANDON_AFTER = "s3p11";
const abandoned = [...keys.slice(0, keys.indexOf(ABANDON_AFTER) + 1).map((k) => report.blocks[k]), GAP, GAP];
const finished = [...abandoned, ...keys.slice(keys.indexOf(ABANDON_AFTER) + 1).map((k) => report.blocks[k])];

const show = (label, blocks) => {
  const doc = layout(blocks);
  console.log(`\n${label} — ${doc.pages.length} pages, ${doc.chars} chars`);
  doc.pages.forEach((p, i) => {
    const used = p.blocks.reduce((h, b) => h + blockH(b), 0) + (i === 0 ? 72 : 0);
    const last = p.blocks[p.blocks.length - 1];
    const tag = last.t === "p" || last.t === "h" ? `"${last.text.slice(0, 22)}…"` : last.t;
    console.log(
      `  p${i + 1}  ${String(used).padStart(3)}/${CAPACITY} used · ${String(CAPACITY - used).padStart(3)} free  ends on ${tag}`,
    );
  });
  return doc;
};

const a = show("abandoned (S2, the drift starts here)", abandoned);
const f = show("finished (S7)", finished);

/* The two beats that depend on where a break lands. */
const tail = a.pages[a.pages.length - 1];
const caretAlone = tail.blocks.every((b) => b.t === "gap");
console.log(
  `\n  caret left alone on a blank page: ${caretAlone ? "yes" : `NO — page ${a.pages.length} also holds ${tail.blocks.length - tail.blocks.filter((b) => b.t === "gap").length} written block(s)`}`,
);
const lastPage = f.pages[f.pages.length - 1];
console.log(`  final page holds: ${lastPage.blocks.map((b) => b.t).join(", ")}`);

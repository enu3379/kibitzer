/**
 * Invariants the film silently breaks when it is re-paced.
 *
 *   node scripts/check-timeline.mjs
 *
 * Every one of these has actually gone wrong at least once, and none of them shows up as
 * an error — they show up as a pointer clicking empty space, a clock running backwards for
 * six frames, or a nudge whose copy says "14분" over a clock reading thirteen. Rendering
 * 1,152 frames to find out costs minutes; this costs a couple of seconds.
 *
 * Checked here:
 *   1. every frame composes at all (stageAt + cursorAt over the whole film)
 *   2. cursor waypoints are in ascending frame order — cursorAt scans linearly
 *   3. the menu-bar clock never runs backwards
 *   4. the two spans the nudge/praise copy asserts are literally true on screen
 *   5. the freeze and the caret void hold the clock still
 *   6. the mall spree: each cart step lands on a product page with the right badge, and
 *      each rail hop opens the product its hot row was holding
 *   7. input sound: every keystroke and click cue lands inside the film, and no single
 *      frame is carrying a pile of them
 *
 * Bundles to real files rather than data: URLs so that `remotion` and `react` resolve out
 * of node_modules; they are external because nothing here renders anything.
 */
import { buildSync } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temps = [];

const load = async (rel, i) => {
  const out = path.join(root, `.check-bundle-${i}.mjs`);
  temps.push(out);
  buildSync({
    entryPoints: [path.join(root, rel)],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["react", "react/jsx-runtime", "react-dom", "remotion"],
    outfile: out,
  });
  return import(pathToFileURL(out).href);
};

const { stageAt, CURSOR_PATH, INPUT_SFX, TYPING_RUNS } = await load("src/scenes/script.ts", 0);
const { cursorAt } = await load("src/lib/cursor.ts", 1);
const { beat, clockAt, clockMinutesAt, driveAt, TOTAL_FRAMES } = await load("src/timeline.ts", 2);
for (const f of temps) fs.rmSync(f, { force: true });

let bad = 0;
const fail = (msg) => {
  bad += 1;
  console.log(`  ✗ ${msg}`);
};

/* 1 — every frame composes */
let thrown = 0;
for (let f = 0; f < TOTAL_FRAMES; f += 1) {
  try {
    stageAt(f);
    cursorAt(f, CURSOR_PATH);
  } catch (e) {
    if (thrown < 5) fail(`f${f}  ${e.message.split("\n")[0]}`);
    thrown += 1;
  }
}
if (thrown === 0) console.log(`  ✓ all ${TOTAL_FRAMES} frames compose`);

/* 2 — cursor waypoints ascending */
let inv = 0;
for (let i = 1; i < CURSOR_PATH.length; i += 1) {
  if (CURSOR_PATH[i].frame < CURSOR_PATH[i - 1].frame) {
    inv += 1;
    if (inv <= 5) fail(`cursor waypoint ${i}: ${CURSOR_PATH[i - 1].frame} → ${CURSOR_PATH[i].frame}`);
  }
}
if (inv === 0) console.log(`  ✓ cursor: ${CURSOR_PATH.length} waypoints, all ascending`);

/* 3 — the clock never runs backwards */
let back = 0;
for (let f = 1; f < TOTAL_FRAMES; f += 1) if (clockMinutesAt(f) < clockMinutesAt(f - 1) - 1e-9) back += 1;
if (back === 0) console.log("  ✓ clock is monotonic");
else fail(`clock goes backwards on ${back} frames`);

/* 4 — the spans the copy asserts */
const span = (a, b) => Math.round(clockMinutesAt(b) - clockMinutesAt(a));
const asserts = (label, got, want) =>
  got === want ? console.log(`  ✓ ${label}: ${got}분`) : fail(`${label}: 화면은 ${got}분, 카피는 ${want}분`);
asserts("snoozeClick → nudge #3", span(beat.snoozeClick, beat.nudge3In), 14);
asserts("igEnter → returnToGoalTab", span(beat.igEnter, beat.returnToGoalTab), 26);

/* 5 — the deliberate holds */
const holds = (a, b, label) =>
  clockAt(a) === clockAt(b)
    ? console.log(`  ✓ ${label} holds at ${clockAt(a)}`)
    : fail(`${label} moves ${clockAt(a)} → ${clockAt(b)}`);
holds(beat.freezeStart, beat.freezeEnd, "freeze");
holds(beat.enter2, beat.switchToBrowser4, "caret void");

/* 6 — the spree
 *
 * The mall is a browsing session now, not a rail loop: an item is reached off the listing
 * grid, off the rail, off the Back button, or off the mall's own search results. Each route
 * has its own way of lying — a rail row that lights up holding the wrong product, a grid
 * card index that no longer matches the grid on screen, a Back that lands somewhere the
 * history never was. So each is checked as what it claims to be, and the routes are read
 * out of the page list rather than restated here.
 */
const shopAt = (f) => {
  const p = stageAt(f).page;
  return p.k === "shop" ? p : null;
};
const carts = [beat.cart1, beat.cart2, beat.cart3, beat.cart4, beat.cart5, beat.cart6];
const hops = [
  { at: beat.hop1, k: "rail" },
  { at: beat.hop2, k: "rail" },
  { at: beat.backClick, k: "back" },
  { at: beat.hop3, k: "rail" },
  { at: beat.searchPick, k: "card" },
  { at: beat.hop4, k: "rail" },
];
const before = bad;
carts.forEach((f, i) => {
  const p = shopAt(f + 1);
  if (!p || p.view !== "detail") fail(`cart${i + 1} @${f}: 상품 페이지가 아님 (${p ? p.view : "not shop"})`);
  else if (p.cart !== i + 1) fail(`cart${i + 1} @${f}: 배지가 ${p.cart}`);
});
// The listing pick is the same shape as the search pick, so it is checked with them.
[{ at: beat.shopPick, k: "card" }, ...hops].forEach(({ at: f, k }) => {
  const from = shopAt(f - 2);
  const to = shopAt(f + 2);
  if (!from || !to) return fail(`${k} @${f}: 쇼핑몰이 화면에 없음`);
  if (to.view !== "detail") return fail(`${k} @${f}: 상품 페이지가 열리지 않음 (${to.view})`);
  // Only a product page has a product to leave; a grid does not.
  if (from.view === "detail" && from.product === to.product && k !== "back")
    fail(`${k} @${f}: 상품이 그대로 (${to.product})`);
  if (k === "rail") {
    if (from.recHot === null) fail(`rail @${f}: 클릭 직전에 밝아진 레일 줄이 없음`);
    else if (from.rec[from.recHot] !== to.product)
      fail(`rail @${f}: 밝아진 줄은 ${from.rec[from.recHot]}인데 ${to.product}가 열림`);
  }
  if (k === "card") {
    const grid = from.view === "results" ? from.results : from.view === "list" ? from.results.map((_, i) => i) : null;
    if (from.listHot === null) fail(`card @${f}: 클릭 직전에 밝아진 카드가 없음`);
    else if (from.view === "results" && grid[from.listHot] !== to.product)
      fail(`card @${f}: 밝아진 카드는 ${grid[from.listHot]}인데 ${to.product}가 열림`);
    else if (from.view === "list" && from.listHot !== to.product)
      fail(`card @${f}: 밝아진 카드는 ${from.listHot}인데 ${to.product}가 열림`);
  }
  if (k === "back") {
    // Back may only land on a page the session has actually been on, and not the one it is
    // leaving — which is the only thing that makes it read as history rather than as a link.
    const seen = [];
    for (let g = beat.shopEnter; g < f; g += 1) {
      const p = shopAt(g);
      if (p && p.view === "detail" && seen[seen.length - 1] !== p.product) seen.push(p.product);
    }
    if (to.product === from.product) fail(`back @${f}: 같은 상품에 그대로 있음 (${to.product})`);
    else if (!seen.includes(to.product)) fail(`back @${f}: 방문한 적 없는 ${to.product}로 돌아감`);
  }
});
// The search: focus, a query that grows, results, and a URL that carries it.
const typing = shopAt(beat.searchResults - 4);
const results = shopAt(beat.searchResults + 2);
if (!typing || !typing.searchFocus || !typing.query) fail("검색: 입력 중인 질의가 검색창에 없음");
if (!results || results.view !== "results") fail(`검색: 결과 격자가 뜨지 않음 (${results ? results.view : "not shop"})`);
if (bad === before) console.log("  ✓ mall: 담기 6회 · 격자/레일/뒤로/검색 네 경로, 클릭한 것이 언제나 열린 것");

/* 7 — input sound
 *
 * The cues are derived, so they cannot fall out of sync with the picture; what they CAN
 * do is fall off the end of it. A cue past TOTAL_FRAMES is silently dropped by Remotion
 * and a negative one throws mid-render, and both are what a retime produces when a typed
 * block is pushed past its cut. The density check is the other half: three samples on one
 * frame is not typing, it is a doubled transient, and it means two derivations have
 * started describing the same keypress.
 */
const before7 = bad;
let out = 0;
for (const cue of INPUT_SFX) {
  if (!Number.isFinite(cue.at) || cue.at < 0 || cue.at >= TOTAL_FRAMES) {
    out += 1;
    if (out <= 5) fail(`input cue off the film: ${cue.file} @${cue.at}`);
  }
}
for (const run of TYPING_RUNS) {
  if (!(run.fpc > 0)) fail(`typing run "${run.text.slice(0, 12)}…" has rate ${run.fpc}`);
}
const perFrame = new Map();
for (const cue of INPUT_SFX) perFrame.set(cue.at, (perFrame.get(cue.at) ?? 0) + 1);
const piles = [...perFrame.entries()].filter(([, n]) => n > 2);
for (const [f, n] of piles.slice(0, 5)) fail(`f${f}: ${n} input cues on one frame`);
// A drive anchor out of order reads as a value out of range on the frames around it.
let offRange = 0;
for (let f = 0; f < TOTAL_FRAMES; f += 1) {
  const d = driveAt(f);
  if (!(d >= 0 && d <= 1)) offRange += 1;
}
if (offRange > 0) fail(`drive leaves 0–1 on ${offRange} frames — anchors out of order?`);
if (bad === before7) {
  const keys = INPUT_SFX.filter((c) => c.file.includes("key")).length;
  console.log(`  ✓ input: ${keys} keystrokes + ${INPUT_SFX.length - keys} clicks, ${TYPING_RUNS.length} typed runs`);
  // Measured inside each run rather than over a scene: a window that is mostly browser
  // averages the keyboard away, and what the drive curve shapes is the run itself.
  const rate = (run) => {
    const end = Math.min(run.from + [...run.text].length * run.fpc, run.until ?? Infinity);
    const n = INPUT_SFX.filter((c) => c.at > run.from && c.at <= end + 1 && c.file.includes("key")).length;
    return (n / Math.max(1, end - run.from)) * 30;
  };
  const named = (label, at) => {
    const run = TYPING_RUNS.find((r) => Math.round(r.from) === at);
    return run ? `${label} ${rate(run).toFixed(0)}` : `${label} —`;
  };
  console.log(
    `  · 타건/초 — ${named("목표", beat.goalTypeStart)}` +
      `, ${named("S2 정점", beat.writeP8 - 1)}` +
      `, ${named("힘 빠질 때", beat.writeP11 - 1)}` +
      `, ${named("결론", beat.writeH3 - 1)}`,
  );
}

if (bad > 0) {
  console.log(`\n${bad} problem(s)`);
  process.exit(1);
}
console.log("\nall ok");

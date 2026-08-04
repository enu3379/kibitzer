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

const { stageAt, CURSOR_PATH } = await load("src/scenes/script.ts", 0);
const { cursorAt } = await load("src/lib/cursor.ts", 1);
const { beat, clockAt, clockMinutesAt, TOTAL_FRAMES } = await load("src/timeline.ts", 2);
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

/* 6 — the spree */
const shopAt = (f) => {
  const p = stageAt(f).page;
  return p.k === "shop" ? p : null;
};
const carts = [beat.cart1, beat.cart2, beat.cart3, beat.cart4, beat.cart5, beat.cart6, beat.cart7];
const hops = [beat.hop1, beat.hop2, beat.hop3, beat.hop4, beat.hop5, beat.hop6];
const before = bad;
carts.forEach((f, i) => {
  const p = shopAt(f + 1);
  if (!p || p.view !== "detail") fail(`cart${i + 1} @${f}: 상품 페이지가 아님 (${p ? p.view : "not shop"})`);
  else if (p.cart !== i + 1) fail(`cart${i + 1} @${f}: 배지가 ${p.cart}`);
});
hops.forEach((f, i) => {
  const from = shopAt(f - 2);
  const to = shopAt(f + 2);
  if (!from || !to) return fail(`hop${i + 1} @${f}: 쇼핑몰이 화면에 없음`);
  if (from.product === to.product) fail(`hop${i + 1} @${f}: 상품이 그대로 (${to.product})`);
  if (from.recHot === null) fail(`hop${i + 1} @${f}: 클릭 직전에 밝아진 레일 줄이 없음`);
  else if (from.rec[from.recHot] !== to.product)
    fail(`hop${i + 1} @${f}: 밝아진 줄은 ${from.rec[from.recHot]}인데 ${to.product}가 열림`);
});
if (bad === before) console.log("  ✓ spree: 담기 7회 · 레일 hop 6회, 밝아진 줄이 언제나 다음 상품");

if (bad > 0) {
  console.log(`\n${bad} problem(s)`);
  process.exit(1);
}
console.log("\nall ok");

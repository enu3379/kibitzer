/**
 * Renders the storyboard key-beat stills.
 *
 * Bundles once and reuses it for every frame — `remotion still` would re-bundle per
 * invocation, which turns a 30s job into several minutes.
 *
 *   node scripts/render-stills.mjs            # all beats, half scale
 *   node scripts/render-stills.mjs s3-nudge-1 # one beat
 */
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "storyboard");

/** Keep in sync with src/timeline.ts and storyboard.md. */
const BEATS = [
  { id: "s1-goal-typing", frame: 100, caption: "S1 · 목표 입력" },
  { id: "s1-tracking-on", frame: 130, caption: "S1 · 추적 시작 직후" },
  { id: "s2-music", frame: 152, caption: "S2 · 배경음악 재생 (딴짓 아님)" },
  { id: "s2-news-read", frame: 194, caption: "S2 · 기사 정독" },
  { id: "s2-stats", frame: 222, caption: "S2 · 통계 대시보드" },
  { id: "s2-app-switch", frame: 233, caption: "S2 · Cmd-Tab → 에디터 앱" },
  { id: "s2-editor-typing", frame: 282, caption: "S2 · 보고서 개요 작성" },
  { id: "s3-ig-feed", frame: 326, caption: "S3 · 딴짓① 소셜 피드" },
  { id: "s3-nudge-1", frame: 392, caption: "S3 · DM 몰아치기 + 첫 훈수" },
  { id: "s4-nudge-2", frame: 462, caption: "S4 · 두 번째 훈수 + 5분만" },
  { id: "s4-portal", frame: 506, caption: "S4 · 딴짓② 포털 검색" },
  { id: "s4-shop-cart-3", frame: 560, caption: "S4 · 딴짓③ 쇼핑몰 · 장바구니 누적" },
  { id: "s4-cart-7", frame: 598, caption: "S4 · 장바구니 7개" },
  { id: "s4-nudge-3", frame: 636, caption: "S4 · 스누즈 콜백" },
  { id: "s5-freeze", frame: 684, caption: "S5 · 정지 + 줌인" },
  { id: "s5-closing-tabs", frame: 728, caption: "S5 · 탭 정리 (음악 탭은 유지)" },
  { id: "s6-praise", frame: 800, caption: "S6 · 복귀 칭찬" },
  { id: "s7-report-done", frame: 876, caption: "S7 · 보고서 완성" },
  { id: "s7-mail-send", frame: 920, caption: "S7 · 메일 전송" },
  { id: "s7-end-session", frame: 948, caption: "S7 · 세션 종료 클릭" },
  { id: "s7-summary", frame: 962, caption: "S7 · 세션 요약" },
  { id: "s8-endcard", frame: 1012, caption: "S8 · 엔드카드" },
];

const only = process.argv[2];
const beats = only ? BEATS.filter((b) => b.id === only) : BEATS;
if (beats.length === 0) {
  console.error(`No beat matches "${only}". Known ids:\n  ${BEATS.map((b) => b.id).join("\n  ")}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

console.log("bundling…");
const serveUrl = await bundle({
  entryPoint: path.join(root, "src", "index.ts"),
  onProgress: (p) => process.stdout.write(`\r  ${p}%   `),
});
process.stdout.write("\n");

const composition = await selectComposition({ serveUrl, id: "KibitzerPromo" });

for (const b of beats) {
  const output = path.join(outDir, `${b.id}.png`);
  await renderStill({
    composition,
    serveUrl,
    output,
    frame: b.frame,
    scale: 0.5,
    overwrite: true,
    imageFormat: "png",
  });
  console.log(`  ✓ ${b.id}.png  (frame ${b.frame} — ${b.caption})`);
}

console.log(`\n${beats.length} still(s) → ${path.relative(process.cwd(), outDir)}`);

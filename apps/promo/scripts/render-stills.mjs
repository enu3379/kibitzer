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
  { id: "s2-news-read", frame: 172, caption: "S2 · 기사 정독" },
  { id: "s2-stats", frame: 200, caption: "S2 · 통계 대시보드" },
  { id: "s2-app-switch", frame: 211, caption: "S2 · Cmd-Tab → 에디터 앱" },
  { id: "s2-editor-typing", frame: 272, caption: "S2 · 보고서 개요 작성" },
  { id: "s3-nudge-1", frame: 362, caption: "S3 · 첫 훈수" },
  { id: "s3-ignored", frame: 410, caption: "S3 · 무시하고 다음 영상" },
  { id: "s4-nudge-2", frame: 452, caption: "S4 · 두 번째 훈수 + 5분만" },
  { id: "s4-montage", frame: 556, caption: "S4 · 시간 경과 몽타주" },
  { id: "s4-nudge-3", frame: 628, caption: "S4 · 스누즈 콜백" },
  { id: "s5-freeze", frame: 674, caption: "S5 · 정지 + 줌인" },
  { id: "s5-closing-tabs", frame: 718, caption: "S5 · 탭 정리" },
  { id: "s6-praise", frame: 800, caption: "S6 · 복귀 칭찬" },
  { id: "s7-report-done", frame: 880, caption: "S7 · 보고서 완성" },
  { id: "s7-mail-send", frame: 924, caption: "S7 · 메일 전송" },
  { id: "s7-end-session", frame: 952, caption: "S7 · 세션 종료 클릭" },
  { id: "s7-summary", frame: 966, caption: "S7 · 세션 요약" },
  { id: "s8-endcard", frame: 1020, caption: "S8 · 엔드카드" },
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

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
  { id: "s2-write-1", frame: 240, caption: "S2 · 에디터에서 빠른 작성" },
  { id: "s2-select-stats", frame: 292, caption: "S2 · 대시보드 두 행 선택 + ⌘C" },
  { id: "s2-paste-1", frame: 313, caption: "S2 · ⌘V — 붙여넣기 블록" },
  { id: "s2-select-news", frame: 410, caption: "S2 · 기사 인용구 선택 + ⌘C" },
  { id: "s2-paste-2", frame: 430, caption: "S2 · 두 번째 붙여넣기" },
  { id: "s2-doc-full", frame: 484, caption: "S2 · 한 시간 뒤의 문서" },
  { id: "s2-idle-caret", frame: 524, caption: "S2 · 엔터 두 번, 커서만 깜빡" },

  { id: "s3-omni-autocomplete", frame: 589, caption: "S3 · 새 탭 → 'g' → 자동완성 → Tab" },
  { id: "s3-ig-feed", frame: 612, caption: "S3 · 딴짓① 소셜 피드" },
  { id: "s3-dm-reply", frame: 652, caption: "S3 · DM 답장" },
  { id: "s3-dm-interrupt", frame: 694, caption: "S3 · 다른 사람이 끼어듦" },
  { id: "s3-music-link", frame: 722, caption: "S3 · 링크로 받은 뮤직비디오" },
  { id: "s3-music", frame: 740, caption: "S3 · 노래 재생" },
  { id: "s3-nudge-1", frame: 792, caption: "S3 · 첫 훈수 (2배 토스트)" },

  { id: "s4-nudge-2", frame: 846, caption: "S4 · 두 번째 훈수 + 5분만" },
  { id: "s4-portal", frame: 900, caption: "S4 · 딴짓② 포털 검색" },
  { id: "s4-shop-list", frame: 932, caption: "S4 · 쇼핑몰 목록 스크롤" },
  { id: "s4-shop-detail", frame: 970, caption: "S4 · 상품 클릭 · 장바구니" },
  { id: "s4-dm-peek", frame: 990, caption: "S4 · DM 왕복 — 그새 쌓인 알림" },
  { id: "s4-cart-7", frame: 1078, caption: "S4 · 장바구니 7개" },
  { id: "s4-nudge-3", frame: 1102, caption: "S4 · 스누즈 콜백" },

  { id: "s5-freeze", frame: 1132, caption: "S5 · 전부 멈춤 · 정적" },

  { id: "s6-closing-tabs", frame: 1202, caption: "S6 · 무관한 탭 정리" },
  { id: "s6-editor-look", frame: 1268, caption: "S6 · 문서를 한 번 열어봄" },
  { id: "s6-praise", frame: 1336, caption: "S6 · 복귀 칭찬" },

  { id: "s7-report-done", frame: 1442, caption: "S7 · 보고서 완성" },
  { id: "s7-mail-send", frame: 1490, caption: "S7 · 메일 전송" },
  { id: "s7-summary", frame: 1538, caption: "S7 · 세션 요약" },
  { id: "s8-endcard", frame: 1594, caption: "S8 · 엔드카드" },
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

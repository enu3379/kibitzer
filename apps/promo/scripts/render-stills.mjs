/**
 * Renders the storyboard key-beat stills.
 *
 * Bundles once and reuses it for every frame — `remotion still` would re-bundle per
 * invocation, which turns a 30s job into several minutes.
 *
 *   node scripts/render-stills.mjs            # all beats, half scale
 *   node scripts/render-stills.mjs s3-nudge-1 # one beat
 *   node scripts/render-stills.mjs s2         # every beat whose id starts with s2
 */
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { buildSync } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "storyboard");

/**
 * Read the beat table straight out of src/timeline.ts.
 *
 * These frames used to be written out as literals and went stale every time the film was
 * re-paced — silently at first, then all at once when a frame ran past the end of the
 * composition and the render threw. Anchoring each still to the beat it is a picture *of*
 * means a retime moves the stills with it.
 */
const compiled = buildSync({
  entryPoints: [path.join(root, "src", "timeline.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const { beat, TOTAL_FRAMES } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

const BEATS = [
  { id: "s1-goal-typing", frame: beat.goalTypeEnd - 8, caption: "S1 · 목표 입력" },
  { id: "s1-tracking-on", frame: beat.startClick + 4, caption: "S1 · 추적 시작 직후" },

  { id: "s2-search", frame: beat.searchEnter1 + 6, caption: "S2 · 첫 검색 결과" },
  { id: "s2-news-read", frame: beat.newsEnter + 8, caption: "S2 · 기사 정독" },
  // +5, not +8: switchToBrowser1 raises the Cmd-Tab overlay at +6 and it covers the page
  // this still exists to show the *volume* of.
  { id: "s2-write-1", frame: beat.writeP2 + 5, caption: "S2 · 사이클 A — 1장 제목 + 2문단" },
  { id: "s2-select-stats", frame: beat.copy1, caption: "S2 · 대시보드 네 행 선택 + ⌘C" },
  { id: "s2-paste-1", frame: beat.paste1 + 3, caption: "S2 · ⌘V — 그새 두 장이 늘어 있음" },
  { id: "s2-cohorts", frame: beat.cohortsEnter + 6, caption: "S2 · 코호트 페이지 (열 프레임)" },
  { id: "s2-select-news", frame: beat.copy2, caption: "S2 · 기사 인용구 선택 + ⌘C" },
  { id: "s2-paste-2", frame: beat.paste2 + 3, caption: "S2 · 두 번째 붙여넣기" },
  { id: "s2-doc-full", frame: beat.writeP11 + 14, caption: "S2 · 한 시간 뒤의 문서 — 4페이지 꽉 참" },
  { id: "s2-idle-caret", frame: beat.enter2 + 6, caption: "S2 · 엔터 두 번, 4페이지 빈 줄에 커서만" },

  { id: "s3-omni-autocomplete", frame: beat.omniTab + 2, caption: "S3 · 새 탭 → 'g' → 자동완성 → Tab" },
  { id: "s3-ig-feed", frame: beat.igEnter + 10, caption: "S3 · 딴짓① 소셜 피드" },
  { id: "s3-dm-reply", frame: beat.dmReply1 + 6, caption: "S3 · DM 답장" },
  { id: "s3-dm-interrupt", frame: beat.dmInterrupt + 2, caption: "S3 · 다른 사람이 끼어듦" },
  { id: "s3-music-link", frame: beat.musicOpen - 4, caption: "S3 · 링크로 받은 뮤직비디오" },
  { id: "s3-music", frame: beat.musicOpen + 8, caption: "S3 · 노래 재생" },
  { id: "s3-nudge-1", frame: beat.nudge1In + 12, caption: "S3 · 첫 훈수 (1.5배 토스트)" },

  { id: "s4-nudge-2", frame: beat.nudge2In + 14, caption: "S4 · 두 번째 훈수 + 5분만" },
  { id: "s4-portal", frame: beat.portalQuery + 6, caption: "S4 · 딴짓② 포털 검색" },
  { id: "s4-shop-list", frame: beat.shopPick - 6, caption: "S4 · 쇼핑몰 목록 스크롤" },
  { id: "s4-shop-detail", frame: beat.cart2 - 4, caption: "S4 · 상품 클릭 · 장바구니" },
  { id: "s4-dm-peek", frame: beat.dmPeek1 + 6, caption: "S4 · DM 왕복 — 그새 쌓인 알림" },
  { id: "s4-cart-7", frame: beat.cart7 + 3, caption: "S4 · 장바구니 7개" },
  { id: "s4-nudge-3", frame: beat.nudge3In + 12, caption: "S4 · 스누즈 콜백" },

  { id: "s5-freeze", frame: beat.freezeStart + 15, caption: "S5 · 전부 멈춤 · 정적" },

  { id: "s6-closing-tabs", frame: beat.closeTab2 + 4, caption: "S6 · 무관한 탭 정리" },
  { id: "s6-editor-look", frame: beat.switchToEditor5 + 10, caption: "S6 · 문서를 한 번 열어봄 — 떠날 때 그대로" },
  { id: "s6-praise", frame: beat.praiseIn + 12, caption: "S6 · 복귀 칭찬" },

  { id: "s7-report-done", frame: beat.chartIn + 4, caption: "S7 · 보고서 완성 — 6페이지 · 6,146자 · 참고 자료까지" },
  { id: "s7-mail-send", frame: beat.sendClick + 3, caption: "S7 · 메일 전송" },
  { id: "s7-summary", frame: beat.summaryShown + 8, caption: "S7 · 세션 요약" },
  { id: "s8-endcard", frame: beat.endCardIn + 30, caption: "S8 · 엔드카드" },
].map((b) => ({ ...b, frame: Math.min(b.frame, TOTAL_FRAMES - 1) }));

const only = process.argv[2];
const beats = only ? BEATS.filter((b) => b.id === only || b.id.startsWith(only)) : BEATS;
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

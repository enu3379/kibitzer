import { build, context } from "esbuild"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const watch = process.argv.includes("--watch")
// 기본은 배포 빌드. `--dev`(또는 KIBITZER_DEV=1)일 때만 개발자 전용 UI가 포함된다.
const dev = process.argv.includes("--dev") || process.env.KIBITZER_DEV === "1"
const extensionRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(extensionRoot, "../..")
const distDir = join(extensionRoot, "dist")

// `<!-- dev-only:start -->` ~ `<!-- dev-only:end -->` 구간은 배포 빌드에서 제거한다.
const DEV_ONLY_BLOCK = /[^\S\n]*<!--\s*dev-only:start\s*-->[\s\S]*?<!--\s*dev-only:end\s*-->\n?/g

function copyHtml(srcPath, destPath) {
  if (dev) {
    cpSync(srcPath, destPath)
    return
  }
  writeFileSync(destPath, readFileSync(srcPath, "utf8").replace(DEV_ONLY_BLOCK, ""))
}

const options = {
  entryPoints: [
    join(extensionRoot, "src/background.ts"),
    join(extensionRoot, "src/popup/popup.ts"),
    join(extensionRoot, "src/options/options.ts"),
    ...(dev ? [join(extensionRoot, "src/replay/replay.ts")] : []),
    join(extensionRoot, "src/onboarding/onboarding.ts"),
    join(extensionRoot, "src/localPdfPrompt/localPdfPrompt.ts"),
    join(extensionRoot, "src/offscreen.ts"),
  ],
  outdir: distDir,
  outbase: join(extensionRoot, "src"),
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: false,
  sourcemap: false,
}

function copyStatic() {
  mkdirSync(join(distDir, "popup"), { recursive: true })
  mkdirSync(join(distDir, "options"), { recursive: true })
  // 개발 빌드 후 배포 빌드를 돌렸을 때 dist에 리플레이 잔재가 남지 않도록.
  if (dev) mkdirSync(join(distDir, "replay"), { recursive: true })
  else rmSync(join(distDir, "replay"), { recursive: true, force: true })
  mkdirSync(join(distDir, "onboarding"), { recursive: true })
  mkdirSync(join(distDir, "localPdfPrompt"), { recursive: true })
  mkdirSync(join(distDir, "assets", "ort"), { recursive: true })
  mkdirSync(join(distDir, "LICENSES"), { recursive: true })
  cpSync(join(extensionRoot, "manifest.json"), join(distDir, "manifest.json"))
  cpSync(join(extensionRoot, "src/popup/popup.html"), join(distDir, "popup/popup.html"))
  copyHtml(join(extensionRoot, "src/options/options.html"), join(distDir, "options/options.html"))
  if (dev) cpSync(join(extensionRoot, "src/replay/replay.html"), join(distDir, "replay/replay.html"))
  cpSync(join(extensionRoot, "src/onboarding/onboarding.html"), join(distDir, "onboarding/onboarding.html"))
  cpSync(join(extensionRoot, "src/localPdfPrompt/localPdfPrompt.html"), join(distDir, "localPdfPrompt/localPdfPrompt.html"))
  cpSync(join(extensionRoot, "src/offscreen.html"), join(distDir, "offscreen.html"))
  cpSync(join(extensionRoot, "icons"), join(distDir, "icons"), { recursive: true })
  // Bundles the ONNX model + tokenizer (model.onnx is fetched by assets:check first).
  cpSync(join(extensionRoot, "assets"), join(distDir, "assets"), { recursive: true })
  cpSync(
    join(extensionRoot, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
    join(distDir, "assets/ort/ort-wasm-simd-threaded.wasm"),
  )
  // Licensing files shipped with the packaged extension.
  cpSync(join(repoRoot, "docs/THIRD_PARTY_NOTICES.md"), join(distDir, "THIRD_PARTY_NOTICES.md"))
  cpSync(join(repoRoot, "LICENSES/Apache-2.0.txt"), join(distDir, "LICENSES/Apache-2.0.txt"))
}

if (watch) {
  const ctx = await context(options)
  copyStatic()
  await ctx.watch()
} else {
  await build(options)
  copyStatic()
}

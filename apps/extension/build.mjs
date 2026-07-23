import { build, context } from "esbuild"
import { cpSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const watch = process.argv.includes("--watch")
const extensionRoot = dirname(fileURLToPath(import.meta.url))
const distDir = join(extensionRoot, "dist")

const options = {
  entryPoints: [
    join(extensionRoot, "src/background.ts"),
    join(extensionRoot, "src/popup/popup.ts"),
    join(extensionRoot, "src/offscreen/offscreen.ts"),
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
  mkdirSync(join(distDir, "offscreen"), { recursive: true })
  mkdirSync(join(distDir, "assets", "ort"), { recursive: true })
  cpSync(join(extensionRoot, "manifest.json"), join(distDir, "manifest.json"))
  cpSync(join(extensionRoot, "src/popup/popup.html"), join(distDir, "popup/popup.html"))
  cpSync(join(extensionRoot, "src/offscreen/offscreen.html"), join(distDir, "offscreen/offscreen.html"))
  cpSync(join(extensionRoot, "src/offscreen/ding.wav"), join(distDir, "offscreen/ding.wav"))
  cpSync(join(extensionRoot, "src/offscreen/celebrate.wav"), join(distDir, "offscreen/celebrate.wav"))
  cpSync(join(extensionRoot, "icons"), join(distDir, "icons"), { recursive: true })
  cpSync(join(extensionRoot, "assets"), join(distDir, "assets"), { recursive: true })
  cpSync(
    join(extensionRoot, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
    join(distDir, "assets/ort/ort-wasm-simd-threaded.wasm"),
  )
}

if (watch) {
  const ctx = await context(options)
  copyStatic()
  await ctx.watch()
} else {
  await build(options)
  copyStatic()
}

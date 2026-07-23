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
  mkdirSync(join(distDir, "assets", "ort"), { recursive: true })
  cpSync(join(extensionRoot, "manifest.json"), join(distDir, "manifest.json"))
  cpSync(join(extensionRoot, "src/popup/popup.html"), join(distDir, "popup/popup.html"))
  cpSync(join(extensionRoot, "src/offscreen.html"), join(distDir, "offscreen.html"))
  cpSync(join(extensionRoot, "icons"), join(distDir, "icons"), { recursive: true })
  // Bundles the ONNX model + tokenizer (model.onnx is fetched by assets:check first).
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

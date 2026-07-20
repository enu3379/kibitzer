import { build, context } from "esbuild"
import { execSync } from "node:child_process"
import { cpSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const watch = process.argv.includes("--watch")
const extensionRoot = dirname(fileURLToPath(import.meta.url))
const distDir = join(extensionRoot, "dist")

function gitCommit() {
  try {
    const commit = execSync("git rev-parse --short HEAD", { cwd: extensionRoot }).toString().trim()
    if (!commit) return null
    const dirty = execSync("git status --porcelain --untracked-files=no", { cwd: extensionRoot })
      .toString().trim()
    return dirty ? `${commit}+dirty` : commit
  } catch {
    return null
  }
}

// Injected as a compile-time constant; tsc and node --test run the raw source
// where the identifier is absent (see src/lib/buildInfo.ts).
const buildInfo = { builtAt: new Date().toISOString(), commit: gitCommit() }

const options = {
  define: { __KIBITZER_BUILD__: JSON.stringify(buildInfo) },
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
  cpSync(join(extensionRoot, "manifest.json"), join(distDir, "manifest.json"))
  cpSync(join(extensionRoot, "src/popup/popup.html"), join(distDir, "popup/popup.html"))
  cpSync(join(extensionRoot, "src/offscreen/offscreen.html"), join(distDir, "offscreen/offscreen.html"))
  cpSync(join(extensionRoot, "src/offscreen/ding.wav"), join(distDir, "offscreen/ding.wav"))
  cpSync(join(extensionRoot, "src/offscreen/celebrate.wav"), join(distDir, "offscreen/celebrate.wav"))
  cpSync(join(extensionRoot, "icons"), join(distDir, "icons"), { recursive: true })
}

if (watch) {
  const ctx = await context(options)
  copyStatic()
  await ctx.watch()
} else {
  await build(options)
  copyStatic()
}

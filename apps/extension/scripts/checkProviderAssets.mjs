import { createHash } from "node:crypto"
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const modelRoot = join(extensionRoot, "assets", "models", "koen-e5-tiny")
const manifestPath = join(modelRoot, "model-manifest.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

for (const asset of manifest.files) {
  const path = join(modelRoot, asset.relative_path)
  // Large assets (the ONNX model) are not committed to git — they are fetched at
  // build/test time from a pinned URL in the manifest and verified below. Small
  // text assets stay in the repo and have no `url`.
  if (!existsSync(path)) {
    if (!asset.url) throw new Error(`missing provider asset: ${asset.relative_path}`)
    console.log(`fetching ${asset.relative_path} from ${asset.url}`)
    await downloadAsset(asset.url, path)
  }
  const size = statSync(path).size
  if (size !== asset.size) {
    throw new Error(
      `provider asset size mismatch: ${asset.relative_path} (${size} != ${asset.size})`,
    )
  }
  const digest = await sha256(path)
  if (digest !== asset.sha256) {
    throw new Error(`provider asset hash mismatch: ${asset.relative_path}`)
  }
}

const ortWasm = join(
  extensionRoot,
  "node_modules",
  "onnxruntime-web",
  "dist",
  "ort-wasm-simd-threaded.wasm",
)
if (!existsSync(ortWasm)) {
  throw new Error("onnxruntime-web WASM artifact is missing")
}

console.log(`verified ${manifest.files.length} KoEn E5 assets and ONNX Runtime WASM`)

async function downloadAsset(url, path) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const input = createReadStream(path)
    input.on("data", (chunk) => hash.update(chunk))
    input.on("end", () => resolve(hash.digest("hex")))
    input.on("error", reject)
  })
}

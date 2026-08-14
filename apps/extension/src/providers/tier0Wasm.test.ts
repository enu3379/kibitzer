import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { Tokenizer } from "@huggingface/tokenizers"

import {
  WasmEmbeddingProvider,
  encodeInput,
  meanPoolAndValidate,
} from "./tier0Wasm.ts"

const extensionRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const modelRoot = join(extensionRoot, "assets", "models", "koen-e5-tiny")

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(modelRoot, name), "utf8")) as Record<string, unknown>
}

function assetFetch(): typeof fetch {
  const paths: Record<string, string> = {
    "asset:model": join(modelRoot, "model.onnx"),
    "asset:tokenizer": join(modelRoot, "tokenizer.json"),
    "asset:tokenizer-config": join(modelRoot, "tokenizer_config.json"),
  }
  return (async (input: string | URL | Request) => {
    const path = paths[String(input)]
    if (!path) return new Response(null, { status: 404 })
    return new Response(readFileSync(path))
  }) as typeof fetch
}

test("browser tokenizer IDs match the Python tokenizers contract", () => {
  const tokenizer = new Tokenizer(
    loadJson("tokenizer.json"),
    loadJson("tokenizer_config.json"),
  )
  assert.deepEqual(
    encodeInput(tokenizer, "query: 국내 여행지"),
    {
      ids: [0, 37, 832, 12, 11804, 9339, 778, 2],
      attentionMask: [1, 1, 1, 1, 1, 1, 1, 1],
      tokenTypeIds: [0, 0, 0, 0, 0, 0, 0, 0],
    },
  )
  assert.deepEqual(
    encodeInput(tokenizer, "query: LG그램 수리").ids,
    [0, 37, 832, 12, 7799, 40265, 680, 1238, 2],
  )
  const truncated = encodeInput(
    tokenizer,
    `query: ${"여행 ".repeat(200)}`,
    128,
  )
  assert.equal(truncated.ids.length, 128)
  assert.equal(truncated.ids.at(-1), 2)
})

test("mean pooling validates dimensions and returns an L2 unit vector", () => {
  const vector = meanPoolAndValidate(
    new Float32Array([
      1, 2,
      3, 4,
      100, 100,
    ]),
    [1, 1, 0],
    2,
  )
  assert.ok(Math.abs(vector[0] - 2 / Math.sqrt(13)) < 1e-7)
  assert.ok(Math.abs(vector[1] - 3 / Math.sqrt(13)) < 1e-7)
  assert.throws(
    () => meanPoolAndValidate(new Float32Array([1]), [1], 2),
    /does not match/,
  )
  assert.throws(
    () => meanPoolAndValidate(new Float32Array([0, 0]), [1], 2),
    /zero vector/,
  )
})

test("KoEn E5 WASM inference matches Python reference vectors", async () => {
  const provider = new WasmEmbeddingProvider({
    assets: {
      model: "asset:model",
      tokenizer: "asset:tokenizer",
      tokenizerConfig: "asset:tokenizer-config",
      // Node resolves the package's own WASM artifact. The extension supplies
      // an explicit chrome-extension URL in production.
      wasm: "",
    },
    fetch: assetFetch(),
  })
  const vectors = await provider.embed([
    "국내 여행지",
    "서울 근교 당일치기",
    "Node.js TypeScript 테스트",
  ])

  assert.equal(vectors.length, 3)
  assert.ok(vectors.every((vector) => vector.length === 384))
  for (const vector of vectors) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-6)
  }

  // Python ONNX Runtime CPUExecutionProvider over this same O4 export.
  const pythonHead = [
    0.05927116423845291,
    -0.02506254054605961,
    -0.011684313416481018,
    -0.004579648375511169,
  ]
  for (let index = 0; index < pythonHead.length; index += 1) {
    assert.ok(
      Math.abs(vectors[0][index] - pythonHead[index]) < 2e-4,
      `component ${index}: wasm=${vectors[0][index]} python=${pythonHead[index]}`,
    )
  }
  const cosine = vectors[0].reduce(
    (sum, value, index) => sum + value * vectors[1][index],
    0,
  )
  assert.ok(Math.abs(cosine - 0.3421955704689026) < 2e-4)
})

import { Tokenizer } from "@huggingface/tokenizers"
import * as ort from "onnxruntime-web/wasm"

import type { EmbeddingProvider } from "./types.ts"

export const KOEN_E5_DIMENSIONS = 384
export const KOEN_E5_MAX_LENGTH = 128
export const KOEN_E5_PREFIX = "query: "

export interface WasmEmbeddingAssetUrls {
  model: string
  tokenizer: string
  tokenizerConfig: string
  wasm: string
}

export interface WasmEmbeddingProviderOptions {
  assets: WasmEmbeddingAssetUrls
  dimensions?: number
  maxLength?: number
  normalize?: boolean
  prefix?: string
  fetch?: typeof fetch
}

interface EncodedInput {
  ids: number[]
  attentionMask: number[]
  tokenTypeIds: number[]
}

/**
 * Browser-only KoEn E5 provider using ONNX Runtime's CPU WebAssembly backend.
 * Inputs are intentionally processed one at a time to preserve the Python
 * provider's batch-size-1 contract for this export.
 */
export class WasmEmbeddingProvider implements EmbeddingProvider {
  private readonly assets: WasmEmbeddingAssetUrls
  private readonly dimensions: number
  private readonly maxLength: number
  private readonly normalize: boolean
  private readonly prefix: string
  private readonly fetchFn: typeof fetch
  private tokenizerPromise: Promise<Tokenizer> | null = null
  private sessionPromise: Promise<ort.InferenceSession> | null = null

  constructor(options: WasmEmbeddingProviderOptions) {
    this.assets = options.assets
    this.dimensions = options.dimensions ?? KOEN_E5_DIMENSIONS
    this.maxLength = options.maxLength ?? KOEN_E5_MAX_LENGTH
    this.normalize = options.normalize ?? true
    this.prefix = options.prefix ?? KOEN_E5_PREFIX
    this.fetchFn = options.fetch ?? globalThis.fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const [tokenizer, session] = await Promise.all([
      this.loadTokenizer(),
      this.loadSession(),
    ])
    const vectors: number[][] = []
    for (const text of texts) {
      const encoded = encodeInput(
        tokenizer,
        this.prepare(text),
        this.maxLength,
      )
      vectors.push(await this.embedOne(session, encoded))
    }
    return vectors
  }

  private prepare(text: string): string {
    return `${this.prefix}${text.trim().split(/\s+/u).filter(Boolean).join(" ")}`
  }

  private loadTokenizer(): Promise<Tokenizer> {
    if (!this.tokenizerPromise) {
      this.tokenizerPromise = Promise.all([
        fetchJsonObject(this.fetchFn, this.assets.tokenizer),
        fetchJsonObject(this.fetchFn, this.assets.tokenizerConfig),
      ]).then(([tokenizer, config]) => new Tokenizer(tokenizer, config))
    }
    return this.tokenizerPromise
  }

  private loadSession(): Promise<ort.InferenceSession> {
    if (!this.sessionPromise) {
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      if (this.assets.wasm) {
        ort.env.wasm.wasmPaths = { wasm: this.assets.wasm }
      }
      this.sessionPromise = fetchBytes(this.fetchFn, this.assets.model)
        .then((model) => ort.InferenceSession.create(model, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        }))
        .then((session) => {
          const required = ["input_ids", "attention_mask"]
          if (!required.every((name) => session.inputNames.includes(name))) {
            throw new Error("ONNX embedding model has incompatible inputs")
          }
          if (session.outputNames.length === 0) {
            throw new Error("ONNX embedding model has no outputs")
          }
          return session
        })
    }
    return this.sessionPromise
  }

  private async embedOne(
    session: ort.InferenceSession,
    encoded: EncodedInput,
  ): Promise<number[]> {
    const shape = [1, encoded.ids.length]
    const feeds: Record<string, ort.Tensor> = {
      input_ids: int64Tensor(encoded.ids, shape),
      attention_mask: int64Tensor(encoded.attentionMask, shape),
    }
    if (session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = int64Tensor(encoded.tokenTypeIds, shape)
    }
    const output = await session.run(feeds)
    const hidden = output[session.outputNames[0]]
    if (!hidden || hidden.type !== "float32") {
      throw new Error("ONNX embedding model returned an incompatible output")
    }
    const expectedShape = [1, encoded.ids.length, this.dimensions]
    if (!sameShape(hidden.dims, expectedShape)) {
      throw new Error(
        `ONNX hidden state has shape ${hidden.dims.join("x")}; expected ${expectedShape.join("x")}`,
      )
    }
    return meanPoolAndValidate(
      hidden.data as Float32Array,
      encoded.attentionMask,
      this.dimensions,
      this.normalize,
    )
  }
}

export function extensionEmbeddingAssets(): WasmEmbeddingAssetUrls {
  const getUrl = (path: string) => chrome.runtime.getURL(path)
  return {
    model: getUrl("assets/models/koen-e5-tiny/model.onnx"),
    tokenizer: getUrl("assets/models/koen-e5-tiny/tokenizer.json"),
    tokenizerConfig: getUrl("assets/models/koen-e5-tiny/tokenizer_config.json"),
    wasm: getUrl("assets/ort/ort-wasm-simd-threaded.wasm"),
  }
}

export function encodeInput(
  tokenizer: Tokenizer,
  text: string,
  maxLength = KOEN_E5_MAX_LENGTH,
): EncodedInput {
  const encoded = tokenizer.encode(text, { return_token_type_ids: true })
  let ids = [...encoded.ids]
  let attentionMask = [...encoded.attention_mask]
  let tokenTypeIds = [...encoded.token_type_ids]
  if (ids.length > maxLength) {
    const eos = ids.at(-1)
    ids = ids.slice(0, maxLength)
    attentionMask = attentionMask.slice(0, maxLength)
    tokenTypeIds = tokenTypeIds.slice(0, maxLength)
    if (eos !== undefined) ids[maxLength - 1] = eos
  }
  return { ids, attentionMask, tokenTypeIds }
}

export function meanPoolAndValidate(
  hidden: Float32Array,
  attentionMask: readonly number[],
  dimensions = KOEN_E5_DIMENSIONS,
  normalize = true,
): number[] {
  if (hidden.length !== attentionMask.length * dimensions) {
    throw new Error("ONNX hidden state length does not match the attention mask")
  }
  const vector = new Array<number>(dimensions).fill(0)
  let tokenCount = 0
  for (let token = 0; token < attentionMask.length; token += 1) {
    if (!attentionMask[token]) continue
    tokenCount += 1
    const offset = token * dimensions
    for (let component = 0; component < dimensions; component += 1) {
      vector[component] += hidden[offset + component]
    }
  }
  if (tokenCount === 0) throw new Error("ONNX embedding attention mask is empty")
  let normSquared = 0
  for (let component = 0; component < dimensions; component += 1) {
    vector[component] /= tokenCount
    if (!Number.isFinite(vector[component])) {
      throw new Error("ONNX embedding contains non-finite values")
    }
    normSquared += vector[component] * vector[component]
  }
  const norm = Math.sqrt(normSquared)
  if (norm === 0) throw new Error("ONNX embedding is a zero vector")
  if (normalize) {
    for (let component = 0; component < dimensions; component += 1) {
      vector[component] /= norm
    }
  }
  return vector
}

function int64Tensor(values: readonly number[], dims: readonly number[]): ort.Tensor {
  return new ort.Tensor(
    "int64",
    BigInt64Array.from(values, (value) => BigInt(value)),
    [...dims],
  )
}

async function fetchJsonObject(
  fetchFn: typeof fetch,
  url: string,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url)
  if (!response.ok) throw new Error("embedding tokenizer asset could not be loaded")
  const value: unknown = await response.json()
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("embedding tokenizer asset is not a JSON object")
  }
  return value as Record<string, unknown>
}

async function fetchBytes(fetchFn: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetchFn(url)
  if (!response.ok) throw new Error("embedding model asset could not be loaded")
  return new Uint8Array(await response.arrayBuffer())
}

function sameShape(actual: readonly number[], expected: readonly number[]): boolean {
  return (
    actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
  )
}

// Tier 0 relevance: embed the goal and the page title with the WASM KoEn-E5 model
// and compare by cosine similarity. Lifted (de-shadowed) from apps/extension's
// providerShadow. tauOk recalibrated for the O4 export (see tier0-embedding-o4).

import { WasmEmbeddingProvider, extensionEmbeddingAssets } from "../providers/tier0Wasm.ts"
import type { Verdict } from "../core/gauge/types.ts"

/** O4-recalibrated Tier 0 OK threshold (FPR<=10% operating point = 0.587 -> 0.59). */
export const TAU_OK = 0.59

let provider: WasmEmbeddingProvider | null = null
function embedder(): WasmEmbeddingProvider {
  if (!provider) provider = new WasmEmbeddingProvider({ assets: extensionEmbeddingAssets() })
  return provider
}

// The goal is fixed for a session; cache its embedding across page checks.
let goalCache: { text: string; vector: number[] } | null = null
async function goalVector(goal: string): Promise<number[]> {
  if (goalCache?.text === goal) return goalCache.vector
  const [vector] = await embedder().embed([goal])
  goalCache = { text: goal, vector }
  return vector
}

/** Dot product of two L2-normalized embeddings == cosine similarity. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error("embedding dimensions differ")
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

/** Map a raw similarity to a verdict at the given threshold. Pure — unit-tested. */
export function verdictFor(score: number, tauOk: number = TAU_OK): Verdict {
  return score >= tauOk ? "OK" : "DRIFT"
}

export interface Tier0Result {
  score: number
  verdict: Verdict
}

/** Embed goal + title, return the similarity and Tier 0 verdict. */
export async function judgeTier0(goal: string, title: string, tauOk: number = TAU_OK): Promise<Tier0Result> {
  const goalVec = await goalVector(goal)
  const [titleVec] = await embedder().embed([title])
  const score = cosine(goalVec, titleVec)
  return { score, verdict: verdictFor(score, tauOk) }
}

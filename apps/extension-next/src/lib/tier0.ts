// Tier 0 relevance: embed the goal and the page title with the WASM KoEn-E5 model
// and compare by cosine similarity. Lifted (de-shadowed) from apps/extension's
// providerShadow. tauOk recalibrated for the O4 export (see tier0-embedding-o4).

import { WasmEmbeddingProvider, extensionEmbeddingAssets } from "../providers/tier0Wasm.ts"
import type { Verdict } from "../core/gauge/types.ts"
import { scoreParts, type Tier0Parts, type Tier0Refs } from "./relevance.ts"

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

/** Embed an arbitrary string (e.g. a "related"-labeled title → a goal exemplar). */
export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedder().embed([text])
  return vector
}

export interface Tier0Result {
  score: number
  verdict: Verdict
  vector: number[] // the page embedding (for anchor admission / exemplar learning)
  parts: Tier0Parts
}

const NO_REFS: Tier0Refs = { exemplars: [], anchor: null, derived: [] }

/** Embed the title and score it against the goal vector plus any learned reference
 *  vectors (related exemplars, recency anchor, enrichment phrases): the Tier-0 verdict
 *  is `max(exemplar, anchor, derived) >= tauOk`. Falls back to goal-only when refs=∅. */
export async function judgeTier0(
  goal: string,
  title: string,
  tauOk: number = TAU_OK,
  refs: Tier0Refs = NO_REFS,
): Promise<Tier0Result> {
  const goalVec = await goalVector(goal)
  const [titleVec] = await embedder().embed([title])
  const parts = scoreParts(titleVec, goalVec, refs)
  return { score: parts.score, verdict: verdictFor(parts.score, tauOk), vector: titleVec, parts }
}

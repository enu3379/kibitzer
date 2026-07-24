// Tier-0 multi-vector scoring + the reference vectors it maxes over. Faithful port of the
// server's relevance.tier0_score_parts / anchor_admission_eligible (apps/server/app/core/
// relevance.py) with the config constants from apps/server/app/config.py.
//
//   score = max(exemplar_score, anchor_score, derived_contribution)
//     exemplar_score = max cosine over {goal vector} ∪ {"related"-labeled page vectors}
//     anchor_score   = β · cosine(page, mean of recent OK embeddings)
//     derived_score  = max cosine over goal-enrichment phrase vectors (contributes ≥ tau)
//
// Vectors are L2-normalized by the embedder (and meanVector re-normalizes), so cosine is
// the plain dot product. Stored per goal in the IndexedDB kv store; cleared on goal change.

import { kvDelete, kvGet, kvSet } from "./db.ts"

export const BETA = 0.85
export const ANCHOR_WINDOW = 10
export const EXEMPLAR_CAP = 20
export const ANCHOR_EPSILON = 0.05
export const DERIVED_TAU = 0.25

const EXEMPLAR_KEY = "tier0-exemplars" // "related"-labeled page vectors (goal vec added live)
const ANCHOR_KEY = "tier0-anchor-ok" // recent OK page embeddings
const DERIVED_KEY = "tier0-derived" // goal-enrichment phrase vectors

export interface Tier0Parts {
  score: number
  exemplarScore: number
  anchorScore: number
  derivedScore: number
}

export interface Tier0Refs {
  exemplars: number[][] // does NOT include the goal vector (added by the scorer)
  anchor: number[] | null
  derived: number[][]
}

function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function maxCosine(vec: readonly number[], refs: readonly number[][]): number {
  let best = 0
  for (const ref of refs) {
    const c = dot(vec, ref)
    if (c > best) best = c
  }
  return best
}

export function l2normalize(vec: number[]): number[] {
  let norm = 0
  for (const x of vec) norm += x * x
  norm = Math.sqrt(norm)
  return norm === 0 ? vec : vec.map((x) => x / norm)
}

/** Mean of the recent-OK embeddings, re-normalized so dot() == cosine. Null if empty. */
export function meanVector(vecs: number[][]): number[] | null {
  if (vecs.length === 0) return null
  const dim = vecs[0].length
  const sum = new Array<number>(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i += 1) sum[i] += v[i]
  for (let i = 0; i < dim; i += 1) sum[i] /= vecs.length
  return l2normalize(sum)
}

/** The Tier-0 score and its parts. `goalVec` is always the first exemplar. */
export function scoreParts(pageVec: number[], goalVec: number[], refs: Tier0Refs): Tier0Parts {
  const exemplarScore = Math.max(dot(pageVec, goalVec), maxCosine(pageVec, refs.exemplars))
  const anchorScore = refs.anchor ? BETA * dot(pageVec, refs.anchor) : 0
  const derivedScore = maxCosine(pageVec, refs.derived)
  const derivedContribution = derivedScore >= DERIVED_TAU ? derivedScore : 0
  return {
    score: Math.max(exemplarScore, anchorScore, derivedContribution),
    exemplarScore,
    anchorScore,
    derivedScore,
  }
}

/** Whether a page may join the recency anchor. Blocks anchor-only OKs (drift-with-user). */
export function admissionEligible(
  parts: Tier0Parts,
  hasDerived: boolean,
  verdict: string,
  tierReached: number,
): boolean {
  return (
    parts.exemplarScore >= ANCHOR_EPSILON ||
    (hasDerived && parts.derivedScore >= DERIVED_TAU) ||
    (verdict === "OK" && tierReached >= 1)
  )
}

// --- reference-vector storage (per goal; cleared on goal change) ------------------

async function readVecs(key: string): Promise<number[][]> {
  const value = await kvGet<number[][]>(key)
  return Array.isArray(value) ? value : []
}

export async function loadRefs(): Promise<Tier0Refs> {
  const [exemplars, anchorVecs, derived] = await Promise.all([
    readVecs(EXEMPLAR_KEY),
    readVecs(ANCHOR_KEY),
    readVecs(DERIVED_KEY),
  ])
  return { exemplars, anchor: meanVector(anchorVecs), derived }
}

/** Add a "related"-labeled page's embedding as a goal exemplar (capped). */
export async function addExemplar(vec: number[]): Promise<void> {
  const log = await readVecs(EXEMPLAR_KEY)
  log.push(vec)
  await kvSet(EXEMPLAR_KEY, log.slice(-EXEMPLAR_CAP))
}

function sameVec(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** Admit an OK page's embedding into the recency anchor window (capped). Idempotent against
 *  an immediate re-admit of the same vector — a durable dwell is at-least-once, so a
 *  teardown-then-reconcile can re-judge the same page; without this it would double-weight
 *  that page in the anchor mean and burn two of ANCHOR_WINDOW slots. */
export async function admitAnchor(vec: number[]): Promise<void> {
  const log = await readVecs(ANCHOR_KEY)
  if (log.length > 0 && sameVec(log[log.length - 1], vec)) return
  log.push(vec)
  await kvSet(ANCHOR_KEY, log.slice(-ANCHOR_WINDOW))
}

export async function setDerived(vecs: number[][]): Promise<void> {
  await kvSet(DERIVED_KEY, vecs)
}

export async function clearRelevance(): Promise<void> {
  await kvDelete(EXEMPLAR_KEY)
  await kvDelete(ANCHOR_KEY)
  await kvDelete(DERIVED_KEY)
}

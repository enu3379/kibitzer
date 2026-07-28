// Tier-0 multi-vector scoring + the reference vectors it maxes over. Faithful port of the
// server's relevance.tier0_score_parts / anchor_admission_eligible (apps/server/app/core/
// relevance.py) with the config constants from apps/server/app/config.py.
//
//   score = max(exemplar_score, anchor_contribution, derived_contribution)
//     exemplar_score     = max cosine over {goal vector} ∪ {"related"-labeled page vectors}
//     anchor_contribution = β · cosine(page, mean of recent OK embeddings), but only when
//                           direct goal affinity ≥ ANCHOR_TIEBREAK_FLOOR (tiebreaker, not
//                           a standalone judge) — and the anchor is disabled by default
//                           (ANCHOR_WINDOW = 0, see below)
//     derived_score      = max cosine over goal-enrichment phrase vectors (contributes ≥ tau)
//
// Vectors are L2-normalized by the embedder (and meanVector re-normalizes), so cosine is
// the plain dot product. Stored per goal in the IndexedDB kv store; cleared on goal change.

import { kvDelete, kvGet, kvSet, kvUpdate } from "./db.ts"

export const BETA = 0.85
// Anchor disabled by default (2026-07-21 anchor-contribution experiments, docs/
// results-2026-07-21-anchor-pollution.md): with tau=0.59 and beta=0.85 the rescue
// threshold cos(page, anchor) >= tau/beta ~= 0.694 was reached in no scenario —
// including the normal-deepening chain the anchor was designed for — while the
// anchor remained the sole self-reinforcing pollution path (webtoon-binge loop).
// The code path stays for rollback/replay comparison; restore a positive window
// only if replay on real session logs shows a non-zero rescue rate.
export const ANCHOR_WINDOW = 0
export const EXEMPLAR_CAP = 20
export const ANCHOR_EPSILON = 0.05
export const DERIVED_TAU = 0.25
// Anchor tiebreaker floors (pollution-loop fix): the anchor term may only lift
// pages with direct goal affinity, and a Tier-1 OK may only join the anchor with
// that same affinity. 0.50 is the O4/WASM-recalibrated operating point
// (docs/results-2026-07-24-anchor-floor-o4.md, tools/anchorFloorStudy.ts): the
// server-era 0.30 leaks under the O4 distribution (binge-affinity tail p99 0.350,
// max 0.450 — 15 chained false-OKs across 160 binge pairings), 0.45 is the first
// full block, and 0.50 adds margin at zero measured rescue cost. Only in effect
// while the anchor is enabled; re-derive from real session logs before re-enabling.
export const ANCHOR_TIEBREAK_FLOOR = 0.5
export const TIER1_ANCHOR_FLOOR = 0.5

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
export function scoreParts(
  pageVec: number[],
  goalVec: number[],
  refs: Tier0Refs,
  anchorTiebreakFloor: number = ANCHOR_TIEBREAK_FLOOR,
): Tier0Parts {
  const exemplarScore = Math.max(dot(pageVec, goalVec), maxCosine(pageVec, refs.exemplars))
  const anchorScore = refs.anchor ? BETA * dot(pageVec, refs.anchor) : 0
  const derivedScore = maxCosine(pageVec, refs.derived)
  const derivedContribution = derivedScore >= DERIVED_TAU ? derivedScore : 0
  // The anchor is a tiebreaker, not a standalone judge: it may only lift pages
  // that already show direct goal affinity. Without this floor, a polluted anchor
  // can solo-OK pages the goal knows nothing about. anchorScore stays raw as a
  // diagnostic.
  const affinity = Math.max(exemplarScore, derivedContribution)
  const anchorContribution = affinity >= anchorTiebreakFloor ? anchorScore : 0
  return {
    score: Math.max(exemplarScore, anchorContribution, derivedContribution),
    exemplarScore,
    anchorScore,
    derivedScore,
  }
}

/** Similarity to the goal itself (exemplars or derived phrases), anchor excluded. */
function goalAffinity(parts: Tier0Parts): number {
  return Math.max(parts.exemplarScore, parts.derivedScore >= DERIVED_TAU ? parts.derivedScore : 0)
}

/** Whether a page may join the recency anchor. Blocks anchor-only OKs (drift-with-user). */
export function admissionEligible(
  parts: Tier0Parts,
  hasDerived: boolean,
  verdict: string,
  tierReached: number,
  tier1AnchorFloor: number = TIER1_ANCHOR_FLOOR,
): boolean {
  // A Tier-1 OK alone is not enough to steer the anchor: one false OK on a
  // self-similar page cluster (e.g. a webtoon binge) seeds a self-reinforcing
  // anchor loop. Tier-1 OKs get their own affinity gate and must not fall through
  // to the epsilon branch — epsilon (0.05) is low enough that even unrelated
  // titles clear it, which would void the Tier-1 floor.
  if (verdict === "OK" && tierReached >= 1) return goalAffinity(parts) >= tier1AnchorFloor
  return (
    parts.exemplarScore >= ANCHOR_EPSILON ||
    (hasDerived && parts.derivedScore >= DERIVED_TAU)
  )
}

// --- reference-vector storage (per goal; cleared on goal change) ------------------

async function readVecs(key: string): Promise<number[][]> {
  const value = await kvGet<number[][]>(key)
  return Array.isArray(value) ? value : []
}

export async function loadRefs(window: number = ANCHOR_WINDOW): Promise<Tier0Refs> {
  const [exemplars, anchorVecs, derived] = await Promise.all([
    readVecs(EXEMPLAR_KEY),
    readVecs(ANCHOR_KEY),
    readVecs(DERIVED_KEY),
  ])
  // window <= 0: anchor disabled — ignore any vectors persisted before the disable.
  return { exemplars, anchor: window > 0 ? meanVector(anchorVecs) : null, derived }
}

/** Add a "related"-labeled page's embedding as a goal exemplar (capped). Atomic read-modify-
 *  write so a concurrent judge/feedback can't drop an entry. */
export async function addExemplar(vec: number[]): Promise<void> {
  await kvUpdate<number[][]>(EXEMPLAR_KEY, (log0) => {
    const log = Array.isArray(log0) ? log0 : []
    return [...log, vec].slice(-EXEMPLAR_CAP)
  })
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
export async function admitAnchor(vec: number[], window: number = ANCHOR_WINDOW): Promise<void> {
  // window <= 0: anchor disabled — never write (and slice(-0) would keep every entry).
  if (window <= 0) return
  await kvUpdate<number[][]>(ANCHOR_KEY, (log0) => {
    const log = Array.isArray(log0) ? log0 : []
    if (log.length > 0 && sameVec(log[log.length - 1], vec)) return log
    return [...log, vec].slice(-window)
  })
}

export async function setDerived(vecs: number[][]): Promise<void> {
  await kvSet(DERIVED_KEY, vecs)
}

export async function clearRelevance(): Promise<void> {
  await kvDelete(EXEMPLAR_KEY)
  await kvDelete(ANCHOR_KEY)
  await kvDelete(DERIVED_KEY)
}

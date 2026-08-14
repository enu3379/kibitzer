// Anchor-floor recalibration study on the O4 export + WASM embedder (the exact
// runtime stack of extension). Re-runs the 2026-07-21 server-era pollution /
// rescue experiments (docs/results-2026-07-21-anchor-pollution.md) against the O4
// score distribution to derive ANCHOR_TIEBREAK_FLOOR / TIER1_ANCHOR_FLOOR values
// that are actually calibrated for this stack — the server-era 0.30 was derived on
// the pre-O4 export (tau_ok 0.6 era).
//
// Usage (from apps/extension):
//   node --experimental-strip-types tools/anchorFloorStudy.ts <pair_scores.csv>
//
// <pair_scores.csv> is docs/benchmarks/tier0-embedding-o4/pair_scores.csv (the
// label-audited 200-pair v3 set, 40 clusters x 5 pages; see PR #137). Embeddings
// are computed live with the bundled KoEn-E5 O4 model via WasmEmbeddingProvider —
// the same code path production uses.
//
// Simulation, per cluster (goal = the cluster's anchor text):
//   1. Visit the cluster's pages in dataset order.
//   2. SEED (worst case): the first DRIFT page is force-treated as a Tier-1 false
//      OK (the LLM mistake that opened the webtoon-binge loop). It joins the
//      anchor only if its direct goal affinity >= tier1 floor f.
//   3. Every later page is scored like tier0.ts does: direct = cos(page, goal);
//      anchor term = BETA * cos(page, anchor mean), admitted into max() only when
//      direct >= tiebreak floor f. Verdict OK when score >= TAU.
//   4. An OK-verdict page joins the anchor via the epsilon branch (direct >=
//      ANCHOR_EPSILON) — the same self-reinforcement path the real runtime has.
// Metrics per floor f:
//   - pollution: DRIFT-labeled pages that verdict OK *because of the anchor term*
//     (direct alone < TAU) — the false-OK chain the loop produces.
//   - rescue:    OK-labeled pages with direct < TAU that the anchor lifts to OK —
//     the benefit the anchor was designed for (server-era measurement: zero).
// A floor is only worth its complexity if it kills pollution without killing a
// non-zero rescue rate.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { WasmEmbeddingProvider } from "../src/providers/tier0Wasm.ts"

// Runtime constants, mirrored from src/lib/tier0.ts / src/lib/relevance.ts.
const TAU = 0.59
const BETA = 0.85
const ANCHOR_EPSILON = 0.05
const WINDOW = 10
const FLOORS = [0.0, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55]

interface Row {
  groupId: string
  goal: string
  title: string
  label: "OK" | "DRIFT"
  onnxScore: number
}

function parseCsv(path: string): Row[] {
  const text = readFileSync(path, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  const header = splitCsvLine(lines[0])
  const col = (name: string): number => {
    const index = header.indexOf(name)
    if (index < 0) throw new Error(`missing column ${name}`)
    return index
  }
  const [gi, ai, ti, li, si] = [col("group_id"), col("anchor"), col("title"), col("label"), col("onnx_score")]
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    return {
      groupId: cells[gi],
      goal: cells[ai],
      title: cells[ti],
      label: cells[li] as Row["label"],
      onnxScore: Number(cells[si]),
    }
  })
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") { cells.push(cell); cell = "" }
    else cell += ch
  }
  cells.push(cell)
  return cells
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

function meanVec(vecs: number[][]): number[] {
  const dim = vecs[0].length
  const sum = new Array<number>(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i += 1) sum[i] += v[i]
  let norm = 0
  for (let i = 0; i < dim; i += 1) { sum[i] /= vecs.length; norm += sum[i] * sum[i] }
  norm = Math.sqrt(norm)
  return norm === 0 ? sum : sum.map((x) => x / norm)
}

interface FloorResult {
  floor: number
  pollution: number // DRIFT pages OK'd only via the anchor term
  rescue: number // OK pages below TAU direct that the anchor lifted
  seedsAdmitted: number // Tier-1 false-OK seeds that entered the anchor
}

function simulate(rows: Row[], vecs: Map<string, number[]>, floor: number): FloorResult {
  const clusters = new Map<string, Row[]>()
  for (const row of rows) {
    const list = clusters.get(row.groupId) ?? []
    list.push(row)
    clusters.set(row.groupId, list)
  }

  let pollution = 0
  let rescue = 0
  let seedsAdmitted = 0
  for (const cluster of clusters.values()) {
    const goalVec = vecs.get(`query: ${cluster[0].goal}`)
    if (!goalVec) throw new Error(`missing goal vec for ${cluster[0].goal}`)
    const anchorLog: number[][] = []
    let seeded = false
    for (const row of cluster) {
      const pageVec = vecs.get(`query: ${row.title}`)
      if (!pageVec) throw new Error(`missing title vec for ${row.title}`)
      const direct = dot(pageVec, goalVec)

      if (!seeded && row.label === "DRIFT") {
        // Worst-case Tier-1 false OK on the cluster's first drift page.
        seeded = true
        if (direct >= floor) {
          anchorLog.push(pageVec)
          seedsAdmitted += 1
        }
        continue
      }

      const anchorMean = anchorLog.length > 0 ? meanVec(anchorLog.slice(-WINDOW)) : null
      const anchorScore = anchorMean ? BETA * dot(pageVec, anchorMean) : 0
      const anchorContribution = direct >= floor ? anchorScore : 0
      const score = Math.max(direct, anchorContribution)
      const verdict = score >= TAU ? "OK" : "DRIFT"
      const anchorDecisive = verdict === "OK" && direct < TAU

      if (anchorDecisive && row.label === "DRIFT") pollution += 1
      if (anchorDecisive && row.label === "OK") rescue += 1

      // Epsilon-branch admission, as in the runtime (legit OKs reinforce the anchor).
      if (verdict === "OK" && direct >= ANCHOR_EPSILON) anchorLog.push(pageVec)
    }
  }
  return { floor, pollution, rescue, seedsAdmitted }
}

const csvPath = process.argv[2]
if (!csvPath) {
  console.error("usage: node --experimental-strip-types tools/anchorFloorStudy.ts <pair_scores.csv>")
  process.exit(1)
}

const rows = parseCsv(csvPath)
const texts = new Set<string>()
for (const row of rows) {
  texts.add(`query: ${row.goal}`)
  texts.add(`query: ${row.title}`)
}

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const modelRoot = join(extensionRoot, "assets", "models", "koen-e5-tiny")
const assetPaths: Record<string, string> = {
  "asset:model": join(modelRoot, "model.onnx"),
  "asset:tokenizer": join(modelRoot, "tokenizer.json"),
  "asset:tokenizer-config": join(modelRoot, "tokenizer_config.json"),
}
const provider = new WasmEmbeddingProvider({
  assets: {
    model: "asset:model",
    tokenizer: "asset:tokenizer",
    tokenizerConfig: "asset:tokenizer-config",
    wasm: "", // Node resolves the package's own WASM artifact
  },
  fetch: (async (input: string | URL | Request) => {
    const path = assetPaths[String(input)]
    if (!path) return new Response(null, { status: 404 })
    return new Response(readFileSync(path))
  }) as typeof fetch,
})

// The provider prepends KOEN_E5_PREFIX ("query: ") internally (its default
// prefix), so we pass raw text; the map keys keep the prefix only as a namespace.
const ordered = [...texts]
console.error(`embedding ${ordered.length} texts with the O4 WASM model...`)
const vectors = await provider.embed(ordered.map((t) => t.replace(/^query: /, "")))
const vecs = new Map<string, number[]>()
ordered.forEach((text, index) => vecs.set(text, vectors[index]))

// Sanity: our dot(goal,title) must reproduce the CSV's onnx_score.
let checked = 0
let maxDelta = 0
for (const row of rows.slice(0, 25)) {
  const a = vecs.get(`query: ${row.goal}`)
  const b = vecs.get(`query: ${row.title}`)
  if (!a || !b) continue
  maxDelta = Math.max(maxDelta, Math.abs(dot(a, b) - row.onnxScore))
  checked += 1
}
console.error(`sanity: ${checked} pairs re-scored, max |Δ| vs csv onnx_score = ${maxDelta.toFixed(6)}`)

const results = FLOORS.map((floor) => simulate(rows, vecs, floor))
console.log("== benchmark clusters (40 x 5, mixed trap types) ==")
console.log("floor,pollution,rescue,seeds_admitted")
for (const r of results) console.log(`${r.floor},${r.pollution},${r.rescue},${r.seedsAdmitted}`)

// ---------------------------------------------------------------------------
// Binge runs: the benchmark's clusters mix trap types, so no page is similar
// enough to a seed for the anchor to chain — the pollution loop needs a run of
// SELF-SIMILAR off-goal pages (the server-era incident shape: webtoon episodes,
// serial shopping, thread paging). These synthetic runs reproduce that shape;
// every goal x run pairing is simulated (all runs are off-goal for all goals).
const BINGE_RUNS: Record<string, string[]> = {
  webtoon: [
    "화산귀환 121화 - 네이버 웹툰",
    "화산귀환 122화 - 네이버 웹툰",
    "화산귀환 123화 - 네이버 웹툰",
    "화산귀환 124화 - 네이버 웹툰",
    "화산귀환 125화 - 네이버 웹툰",
    "화산귀환 126화 - 네이버 웹툰",
    "화산귀환 127화 - 네이버 웹툰",
    "화산귀환 128화 - 네이버 웹툰",
  ],
  mukbang: [
    "쯔양 곱창 10인분 먹방 - YouTube",
    "쯔양 대왕돈까스 챌린지 먹방 - YouTube",
    "쯔양 편의점 신상 털기 먹방 - YouTube",
    "쯔양 마라탕 5단계 먹방 - YouTube",
    "쯔양 회식 무한리필 먹방 - YouTube",
    "쯔양 라면 10봉지 먹방 - YouTube",
  ],
  shopping: [
    "에어팟 프로 2세대 최저가 비교 - 다나와",
    "에어팟 프로 2세대 케이스 추천 TOP 10 - 쿠팡",
    "에어팟 프로 2세대 vs 버즈3 프로 비교 리뷰",
    "에어팟 프로 2세대 중고 시세 - 번개장터",
    "에어팟 프로 2세대 할인 쿠폰 정리 - 뽐뿌",
    "에어팟 프로 2세대 정품 구별법 - 네이버 블로그",
  ],
  community: [
    "ㅋㅋㅋ 오늘자 레전드 짤 모음 - 디시인사이드",
    "실시간 개웃긴 썰 푼다 - 디시인사이드",
    "어제 회사에서 있었던 일 - 디시인사이드",
    "요즘 유행하는 밈 정리해줌 - 디시인사이드",
    "이거 나만 웃긴거냐 - 디시인사이드",
    "점심 메뉴 추천좀 - 디시인사이드",
  ],
}

const goals = [...new Set(rows.map((row) => row.goal))]
for (const run of Object.values(BINGE_RUNS)) {
  for (const title of run) texts.add(`query: ${title}`)
}
const missing = [...texts].filter((t) => !vecs.has(t))
if (missing.length > 0) {
  const extra = await provider.embed(missing.map((t) => t.replace(/^query: /, "")))
  missing.forEach((text, index) => vecs.set(text, extra[index]))
}

interface BingeResult {
  floor: number
  seedsAdmitted: number
  pairsWithChain: number // goal x run pairings with at least one chained false OK
  chained: number // total anchor-caused false OKs after the seed
}

function simulateBinge(floor: number): BingeResult {
  let seedsAdmitted = 0
  let pairsWithChain = 0
  let chained = 0
  for (const goal of goals) {
    const goalVec = vecs.get(`query: ${goal}`)!
    for (const run of Object.values(BINGE_RUNS)) {
      const anchorLog: number[][] = []
      // Tier-1 false OK on the first page of the run (worst case).
      const seedVec = vecs.get(`query: ${run[0]}`)!
      const seedDirect = dot(seedVec, goalVec)
      if (seedDirect >= floor) {
        anchorLog.push(seedVec)
        seedsAdmitted += 1
      }
      let chainHere = 0
      for (const title of run.slice(1)) {
        const pageVec = vecs.get(`query: ${title}`)!
        const direct = dot(pageVec, goalVec)
        const anchorMean = anchorLog.length > 0 ? meanVec(anchorLog.slice(-WINDOW)) : null
        const anchorScore = anchorMean ? BETA * dot(pageVec, anchorMean) : 0
        const anchorContribution = direct >= floor ? anchorScore : 0
        const score = Math.max(direct, anchorContribution)
        if (score >= TAU && direct < TAU) {
          chainHere += 1
          if (direct >= ANCHOR_EPSILON) anchorLog.push(pageVec) // self-reinforcement
        }
      }
      chained += chainHere
      if (chainHere > 0) pairsWithChain += 1
    }
  }
  return { floor, seedsAdmitted, pairsWithChain, chained }
}

// Direct-affinity profile of binge pages vs goals — where must the floor sit?
const affinities: number[] = []
for (const goal of goals) {
  const goalVec = vecs.get(`query: ${goal}`)!
  for (const run of Object.values(BINGE_RUNS)) {
    for (const title of run) affinities.push(dot(vecs.get(`query: ${title}`)!, goalVec))
  }
}
affinities.sort((a, b) => a - b)
const pct = (p: number): string => affinities[Math.min(affinities.length - 1, Math.floor(p * affinities.length))].toFixed(3)
console.log("")
console.log(`== binge direct-affinity profile (${affinities.length} page x goal pairs) ==`)
console.log(`min=${pct(0)} p50=${pct(0.5)} p90=${pct(0.9)} p95=${pct(0.95)} p99=${pct(0.99)} max=${affinities[affinities.length - 1].toFixed(3)}`)

const totalPairs = goals.length * Object.keys(BINGE_RUNS).length
console.log("")
console.log(`== binge runs (${goals.length} goals x ${Object.keys(BINGE_RUNS).length} runs = ${totalPairs} pairings) ==`)
console.log("floor,seeds_admitted,pairs_with_chain,chained_false_oks")
for (const floor of FLOORS) {
  const r = simulateBinge(floor)
  console.log(`${r.floor},${r.seedsAdmitted},${r.pairsWithChain},${r.chained}`)
}

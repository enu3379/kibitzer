import assert from "node:assert/strict"
import test from "node:test"

import { filterDerivedPhrases, parseEnrichmentResponse } from "./goalEnrichment.ts"

test("parseEnrichmentResponse reads clean JSON and caps to max", () => {
  const out = parseEnrichmentResponse('{"phrases": ["a b", "c d", "e f"]}', 2)
  assert.deepEqual(out, ["a b", "c d"])
})

test("parseEnrichmentResponse survives thinking preambles / fences and drops non-strings", () => {
  const wrapped = 'let me think...\n```json\n{"phrases": ["first phrase", 5, "second phrase"]}\n```'
  assert.deepEqual(parseEnrichmentResponse(wrapped, 8), ["first phrase", "second phrase"])
})

test("parseEnrichmentResponse rejects a response with no object", () => {
  assert.throws(() => parseEnrichmentResponse("no json here", 8))
})

// Distinct orthonormal-ish vectors per phrase so nothing is deduped.
const basisEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((_t, i) => {
    const v = new Array<number>(8).fill(0)
    v[i % 8] = 1
    return v
  })

test("filterDerivedPhrases keeps 2–8-token phrases and drops the goal / too-short / too-long", async () => {
  const kept = await filterDerivedPhrases(
    ["one", "two words here", "a b c d e f g h i", "my goal", "another good phrase"],
    "my goal",
    8,
    basisEmbed,
  )
  assert.deepEqual(kept.map((k) => k.phrase), ["two words here", "another good phrase"])
})

test("filterDerivedPhrases drops near-duplicate vectors (cosine > 0.95)", async () => {
  const sameEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0])
  const kept = await filterDerivedPhrases(["alpha beta", "gamma delta"], "goal x", 8, sameEmbed)
  assert.equal(kept.length, 1)
})

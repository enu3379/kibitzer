export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

export type JudgeVerdict = "OK" | "DRIFT"

export interface Tier1Result {
  verdict: JudgeVerdict
  reason: string
}

export interface Tier2Result {
  confirmDrift: boolean
  message: string | null
}

export type Tier2DecisionValue = "notify" | "defer"
export type Tier2ReasonCode =
  | "off_goal"
  | "useful_side_branch"
  | "insufficient_evidence"
export type Tier2EvidenceBasis = "title" | "content" | "both"

export interface Tier2Decision {
  decision: Tier2DecisionValue
  reasonCode: Tier2ReasonCode
  basis: Tier2EvidenceBasis
}

export interface JudgeProvider {
  classifyTier1(payload: Record<string, unknown>): Promise<Tier1Result>
  completeGoalEnrichment(prompt: string, timeoutMs: number): Promise<string>
  confirmTier2(
    payload: Record<string, unknown>,
    systemPrompt?: string,
  ): Promise<Tier2Result>
  decideTier2(
    payload: Record<string, unknown>,
    systemPrompt?: string,
  ): Promise<Tier2Decision>
  writeTier2Message(
    payload: Record<string, unknown>,
    systemPrompt: string,
  ): Promise<string>
}

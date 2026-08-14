import { ProviderResponseError } from "./errors.ts"
import type { Tier1Result, Tier2Decision, Tier2Result } from "./types.ts"

const FALLBACK_TIER2_MESSAGE =
  "지금 보고 있는 페이지가 현재 목표에서 벗어난 것 같습니다. 계속 필요한 흐름인지 확인해볼까요?"

export function parseTier1Json(content: string): Tier1Result {
  const data = loadJsonObject(content)
  const verdict = String(data.verdict ?? "").toLowerCase()
  const reason = truncateCodePoints(String(data.reason ?? "").trim(), 80) || "no reason"
  if (verdict === "ok") return { verdict: "OK", reason }
  if (verdict === "drift") return { verdict: "DRIFT", reason }
  throw new ProviderResponseError("schema", `invalid tier1 verdict: ${verdict}`)
}

export function parseTier2Json(content: string): Tier2Result {
  const data = loadJsonObject(content)
  if (typeof data.confirm_drift !== "boolean") {
    throw new ProviderResponseError("schema", "tier2 confirm_drift must be boolean")
  }
  const rawMessage = data.message
  let message =
    rawMessage == null
      ? null
      : truncateCodePoints(String(rawMessage).trim(), 320)
  if (data.confirm_drift && !message) message = FALLBACK_TIER2_MESSAGE
  return { confirmDrift: data.confirm_drift, message }
}

export function parseTier2DecisionJson(content: string): Tier2Decision {
  const data = loadJsonObject(content)
  if (data.decision !== "notify" && data.decision !== "defer") {
    throw new ProviderResponseError("schema", "tier2 decision must be notify or defer")
  }
  if (
    data.reason_code !== "off_goal"
    && data.reason_code !== "useful_side_branch"
    && data.reason_code !== "insufficient_evidence"
  ) {
    throw new ProviderResponseError("schema", "tier2 reason_code is invalid")
  }
  if (data.basis !== "title" && data.basis !== "content" && data.basis !== "both") {
    throw new ProviderResponseError("schema", "tier2 basis is invalid")
  }
  return {
    decision: data.decision,
    reasonCode: data.reason_code,
    basis: data.basis,
  }
}

export function loadJsonObject(content: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch (firstError) {
    const start = content.indexOf("{")
    const end = content.lastIndexOf("}")
    if (start === -1 || end <= start) {
      throw new ProviderResponseError("content_json", "judge content was not JSON")
    }
    try {
      data = JSON.parse(content.slice(start, end + 1))
    } catch {
      void firstError
      throw new ProviderResponseError("content_json", "judge content was not JSON")
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProviderResponseError("content_json", "judge response must be a JSON object")
  }
  return data as Record<string, unknown>
}

export function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("")
}

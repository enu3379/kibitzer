import type {
  ProviderCallPhase,
  ProviderCalls,
  ProviderCallStatus,
  ProviderResponseStage,
} from "./api"

export type ProviderTier = "tier1" | "tier2"
export type ProviderFailureSeverity = "amber" | "red"

export interface ProviderFailureDiagnostic {
  tier: ProviderTier
  title: string
  severity: ProviderFailureSeverity
  summary: string
  guidance?: string
}

const GENERIC_SUMMARY = "Provider 상태를 확인하세요."
const LEGACY_INVALID_RESPONSE_SUMMARY = "Provider 응답을 판정 결과로 읽지 못했어요."

const REASON_SUMMARIES: Readonly<Record<string, string>> = {
  timeout: "Provider 응답 시간이 초과됐어요.",
  connection: "Provider 서버에 연결하지 못했어요.",
  auth: "API 키가 유효하지 않아요.",
  forbidden: "Provider가 요청을 거부했어요. 모델 접근 권한 또는 요금제를 확인하세요.",
  rate_limited: "Provider 요청 한도에 도달했어요.",
  server_error: "Provider 서버에서 오류가 발생했어요.",
}

interface StageCopy {
  summary: string
  guidance: string
}

const STAGE_COPY: Readonly<Partial<Record<ProviderResponseStage, StageCopy>>> = {
  http_json: {
    summary: "Provider가 올바른 JSON 응답을 보내지 않았어요.",
    guidance: "API 주소와 Provider 호환성을 확인하세요.",
  },
  envelope: {
    summary: "Provider 응답 구조가 예상한 형식과 달라요.",
    guidance: "OpenAI-compatible 또는 Ollama API 설정을 확인하세요.",
  },
  content_json: {
    summary: "판정 내용을 JSON으로 읽지 못했어요.",
    guidance: "설정한 모델이 JSON 출력을 안정적으로 지원하는지 확인하세요.",
  },
  schema: {
    summary: "판정 결과의 필수 값이 올바르지 않아요.",
    guidance: "모델의 판정 형식 호환성을 확인하세요.",
  },
  writer_empty: {
    summary: "Provider가 빈 훈수 문구를 반환했어요.",
    guidance: "이번 알림은 기본 문구로 대신했어요.",
  },
}

function tierLabel(tier: ProviderTier): string {
  return tier === "tier1" ? "Tier 1" : "Tier 2"
}

function titleFor(tier: ProviderTier, phase: ProviderCallPhase | null | undefined): string {
  const prefix = tierLabel(tier)
  if (phase === "judge") {
    return `${prefix} · ${tier === "tier1" ? "1차 페이지 판정" : "최종 페이지 판정"}`
  }
  if (phase === "writer") return `${prefix} · 훈수 문구 생성`
  return `${prefix} · LLM 호출 오류`
}

function severityFor(tier: ProviderTier, phase: ProviderCallPhase | null | undefined): ProviderFailureSeverity {
  if (phase === "writer") return "amber"
  if (phase === "judge" && tier === "tier1") return "amber"
  return "red"
}

function outputExhaustedGuidance(tier: ProviderTier, phase: ProviderCallPhase): string {
  if (phase === "writer") {
    return "writer_max_output_tokens 또는 모델 설정을 확인하세요."
  }
  if (tier === "tier1") {
    return "Tier 1 모델 속도와 max_output_tokens를 확인하세요."
  }
  return "Tier 2 max_output_tokens 또는 모델 설정을 확인하세요."
}

function invalidResponseCopy(
  tier: ProviderTier,
  phase: ProviderCallPhase | null | undefined,
  stage: ProviderResponseStage | null | undefined,
): Pick<ProviderFailureDiagnostic, "summary" | "guidance"> {
  if (stage == null) return { summary: LEGACY_INVALID_RESPONSE_SUMMARY }
  if (phase != null && phase !== "judge" && phase !== "writer") {
    return { summary: GENERIC_SUMMARY }
  }
  if (stage === "output_exhausted") {
    return {
      summary: "응답이 출력 한도에 걸려 완성되지 않았어요.",
      ...(phase === "judge" || phase === "writer"
        ? { guidance: outputExhaustedGuidance(tier, phase) }
        : {}),
    }
  }
  return STAGE_COPY[stage] ?? { summary: GENERIC_SUMMARY }
}

export function providerFailureDiagnostic(
  tier: ProviderTier,
  status: ProviderCallStatus,
): ProviderFailureDiagnostic | null {
  if (status.last_result !== "error") return null

  const phase = status.phase
  const copy =
    status.reason === "invalid_response"
      ? invalidResponseCopy(tier, phase, status.stage)
      : { summary: REASON_SUMMARIES[status.reason ?? ""] ?? GENERIC_SUMMARY }

  return {
    tier,
    title: titleFor(tier, phase),
    severity: severityFor(tier, phase),
    ...copy,
  }
}

export function providerFailureDiagnostics(
  calls: ProviderCalls | null | undefined,
): ProviderFailureDiagnostic[] {
  if (!calls) return []
  const diagnostics: ProviderFailureDiagnostic[] = []
  for (const tier of ["tier1", "tier2"] as const) {
    const status = calls[tier]
    if (!status) continue
    const diagnostic = providerFailureDiagnostic(tier, status)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  return diagnostics
}

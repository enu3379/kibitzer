import assert from "node:assert/strict"
import test from "node:test"

import {
  providerFailureDiagnostic,
  providerFailureDiagnostics,
} from "../src/lib/providerFailureDiagnostics.ts"

test("Tier 1 Judge timeout is an amber first-pass diagnosis", () => {
  const diagnostic = providerFailureDiagnostic("tier1", {
    last_result: "error",
    reason: "timeout",
    phase: "judge",
  })

  assert.deepEqual(diagnostic, {
    tier: "tier1",
    title: "Tier 1 · 1차 페이지 판정",
    severity: "amber",
    summary: "Provider 응답 시간이 초과됐어요.",
  })
})

test("Tier 2 Judge schema failure is a red final-verdict diagnosis", () => {
  const diagnostic = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
    phase: "judge",
    stage: "schema",
  })

  assert.equal(diagnostic?.title, "Tier 2 · 최종 페이지 판정")
  assert.equal(diagnostic?.severity, "red")
  assert.equal(diagnostic?.summary, "판정 결과의 필수 값이 올바르지 않아요.")
  assert.equal(diagnostic?.guidance, "모델의 판정 형식 호환성을 확인하세요.")
})

test("Tier 2 Writer empty response is amber and explains the local fallback", () => {
  const diagnostic = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
    phase: "writer",
    stage: "writer_empty",
  })

  assert.equal(diagnostic?.title, "Tier 2 · 훈수 문구 생성")
  assert.equal(diagnostic?.severity, "amber")
  assert.equal(diagnostic?.summary, "Provider가 빈 훈수 문구를 반환했어요.")
  assert.equal(diagnostic?.guidance, "이번 알림은 기본 문구로 대신했어요.")
})

test("output exhaustion guidance distinguishes Tier 1 and Tier 2 Judge settings", () => {
  const tier1 = providerFailureDiagnostic("tier1", {
    last_result: "error",
    reason: "invalid_response",
    phase: "judge",
    stage: "output_exhausted",
  })
  const tier2 = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
    phase: "judge",
    stage: "output_exhausted",
  })

  assert.equal(tier1?.guidance, "Tier 1 모델 속도와 max_output_tokens를 확인하세요.")
  assert.equal(tier2?.guidance, "Tier 2 max_output_tokens 또는 모델 설정을 확인하세요.")
})

test("Writer output exhaustion points to writer_max_output_tokens", () => {
  const diagnostic = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
    phase: "writer",
    stage: "output_exhausted",
  })

  assert.equal(diagnostic?.severity, "amber")
  assert.equal(diagnostic?.guidance, "writer_max_output_tokens 또는 모델 설정을 확인하세요.")
})

test("legacy invalid responses without phase and stage keep the compatible fallback", () => {
  const diagnostic = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
  })

  assert.equal(diagnostic?.title, "Tier 2 · LLM 호출 오류")
  assert.equal(diagnostic?.severity, "red")
  assert.equal(diagnostic?.summary, "Provider 응답을 판정 결과로 읽지 못했어요.")
  assert.equal(diagnostic?.guidance, undefined)
})

test("unknown phase and stage values safely use generic provider copy", () => {
  const unknownPhase = providerFailureDiagnostic("tier1", {
    last_result: "error",
    reason: "invalid_response",
    phase: "future_phase",
    stage: "schema",
  })
  const unknownStage = providerFailureDiagnostic("tier2", {
    last_result: "error",
    reason: "invalid_response",
    phase: "judge",
    stage: "future_stage",
  })

  assert.equal(unknownPhase?.title, "Tier 1 · LLM 호출 오류")
  assert.equal(unknownPhase?.severity, "red")
  assert.equal(unknownPhase?.summary, "Provider 상태를 확인하세요.")
  assert.equal(unknownPhase?.guidance, undefined)
  assert.equal(unknownStage?.summary, "Provider 상태를 확인하세요.")
  assert.equal(unknownStage?.guidance, undefined)
})

test("simultaneous failures are returned in Tier 1 then Tier 2 order", () => {
  const diagnostics = providerFailureDiagnostics({
    tier2: { last_result: "error", reason: "connection", phase: "judge" },
    tier1: { last_result: "error", reason: "timeout", phase: "judge" },
  })

  assert.deepEqual(
    diagnostics.map(({ tier }) => tier),
    ["tier1", "tier2"],
  )
})

test("success, none, absent health, and absent tiers create no diagnostics", () => {
  assert.deepEqual(
    providerFailureDiagnostics({
      tier1: { last_result: "success", reason: null },
      tier2: { last_result: "none" },
    }),
    [],
  )
  assert.deepEqual(providerFailureDiagnostics(undefined), [])
  assert.deepEqual(providerFailureDiagnostics({}), [])
})

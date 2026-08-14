import assert from "node:assert/strict"
import test from "node:test"

import { ProviderResponseError } from "./errors.ts"
import {
  parseTier1Json,
  parseTier2DecisionJson,
  parseTier2Json,
} from "./judgeParsing.ts"

test("Tier 1 parser accepts strict and fenced JSON", () => {
  assert.deepEqual(
    parseTier1Json('{"verdict":"ok","reason":"normal subtopic"}'),
    { verdict: "OK", reason: "normal subtopic" },
  )
  assert.deepEqual(
    parseTier1Json('```json\n{"verdict":"drift","reason":"unrelated"}\n```'),
    { verdict: "DRIFT", reason: "unrelated" },
  )
})

test("Tier 1 parser rejects an unknown verdict with a structured stage", () => {
  assert.throws(
    () => parseTier1Json('{"verdict":"maybe","reason":"unclear"}'),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "schema"
    ),
  )
})

test("Tier 2 legacy parser validates boolean and supplies the fallback message", () => {
  assert.deepEqual(
    parseTier2Json('{"confirm_drift":true,"message":""}'),
    {
      confirmDrift: true,
      message:
        "지금 보고 있는 페이지가 현재 목표에서 벗어난 것 같습니다. 계속 필요한 흐름인지 확인해볼까요?",
    },
  )
  assert.deepEqual(
    parseTier2Json('{"confirm_drift":false,"message":""}'),
    { confirmDrift: false, message: "" },
  )
  assert.throws(
    () => parseTier2Json('{"confirm_drift":"yes","message":"bad"}'),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "schema"
    ),
  )
})

test("Tier 2 decision parser accepts only the three canonical enums", () => {
  assert.deepEqual(
    parseTier2DecisionJson(
      'prefix {"decision":"notify","reason_code":"off_goal","basis":"both"} suffix',
    ),
    {
      decision: "notify",
      reasonCode: "off_goal",
      basis: "both",
    },
  )
  assert.throws(
    () => parseTier2DecisionJson(
      '{"decision":"notify","reason_code":"unknown","basis":"both"}',
    ),
    (error) => (
      error instanceof ProviderResponseError
      && error.stage === "schema"
    ),
  )
})

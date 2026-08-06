// Pure presentation logic over the per-tier provider health records: the popup's warn
// block (fact lines + one consequence line), the toolbar alert level, and the OS
// notification body. Kept DOM-free so every user-facing string and the full state
// matrix are unit-testable.
//
// Vocabulary the consequence table is built on:
//   "tier1 판정 불가" = tier1 has a live error OR its route points at a keyless provider
//   "tier2 판정 불가" = tier2 has a live JUDGE error OR its route is keyless
// A keyless route is deliberate config, not an error: it never produces a fact line and
// never shows the block on its own, but it DOES participate in the consequence line.

import { HEALTH_TTL_MS, type ProviderHealthSnapshot, type TierHealth } from "./providerHealth.ts"

export interface TierKeyless {
  tier1: boolean
  tier2: boolean
}

export interface ProviderWarnFact {
  text: string
  tone: "amber" | "red"
}

export interface ProviderWarnModel {
  /** tier1's line first, at most one per tier. Empty ⇒ the whole block stays hidden. */
  facts: ProviderWarnFact[]
  consequence: string | null
}

/** "{시간}" for a fact line: 조금전 / n분전 / n시간 전. Null once the record passed the
 *  24h expiry — the same cut getProviderHealth applies, so a line can never outlive
 *  the toolbar mark. */
export function formatAgo(ts: number, now: number): string | null {
  const elapsed = now - ts
  if (elapsed >= HEALTH_TTL_MS) return null
  if (elapsed < 60_000) return "조금전"
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes}분전`
  return `${Math.floor(elapsed / 3_600_000)}시간 전`
}

function liveError(record: TierHealth | null | undefined, now: number): TierHealth | null {
  if (!record || record.ok) return null
  return now - record.ts >= HEALTH_TTL_MS ? null : record
}

function fact(label: string, record: TierHealth, tone: "amber" | "red", now: number): ProviderWarnFact | null {
  const ago = formatAgo(record.ts, now)
  return ago == null ? null : { text: `⚠ ${label}(${ago}): ${record.message}`, tone }
}

export function buildProviderWarn(
  health: ProviderHealthSnapshot,
  keyless: TierKeyless,
  now: number,
): ProviderWarnModel {
  const t1 = liveError(health.tier1, now)
  const t2 = liveError(health.tier2, now)
  // A tier2 record without a stage should not exist; if one does, "judge" is the reading
  // that under-promises (judge down ⇒ fallback-template nags), so default to it.
  const t2writer = t2 != null && t2.stage === "writer"
  const t2judge = t2 != null && !t2writer

  const facts: ProviderWarnFact[] = []
  if (t1) {
    const line = fact("빠른 판정 오류", t1, "amber", now)
    if (line) facts.push(line)
  }
  if (t2) {
    const line = fact(t2writer ? "훈수 문구 생성 오류" : "정밀 판정 오류", t2, "red", now)
    if (line) facts.push(line)
  }
  if (facts.length === 0) return { facts, consequence: null }

  const t1cannot = t1 != null || keyless.tier1
  const t2cannot = t2judge || keyless.tier2
  let consequence: string
  if (t1cannot && t2cannot) consequence = "LLM을 사용하지 않고 판정하고, 준비된 문구로만 훈수해요"
  else if (t1 && t2writer) consequence = "멀쩡한 페이지에서 훈수를 받을 수도 있어요. 문구는 준비된 문구로 대체했어요"
  else if (t1) consequence = "멀쩡한 페이지에서 훈수를 받을 수도 있어요"
  else if (t2judge) consequence = "내용 확인 없이 준비된 문구로만 훈수해요"
  else consequence = "훈수 문구 생성에 실패해 준비된 문구로 대체했어요"
  return { facts, consequence }
}

/** Toolbar "!" mark priority: a live Tier-2 error is red, a Tier-1-only error amber,
 *  red wins when both. The snapshot comes from getProviderHealth, which already dropped
 *  expired records. */
export function providerAlertLevel(health: ProviderHealthSnapshot): "red" | "amber" | null {
  if (health.tier2 && !health.tier2.ok) return "red"
  if (health.tier1 && !health.tier1.ok) return "amber"
  return null
}

/** OS-alert body for a Tier-2 judge failure, varied by what Tier 1 can still do at that
 *  moment. A keyless Tier-1 route wins over a (stale) error record: keyless means Tier 1
 *  is not running at all, error or no error. */
export function providerAlertBody(
  tier2ProviderLabel: string,
  message: string,
  tier1: { keyless: boolean; hasLiveError: boolean },
): string {
  const head = `정밀 판정(${tier2ProviderLabel}) 오류: ${message}`
  if (tier1.keyless) return `${head} · 지금은 제목 유사도로만 판정하고, 준비된 문구로 훈수해요. 누르면 설정이 열립니다.`
  if (tier1.hasLiveError) {
    return `${head} · 빠른 판정에도 오류가 있어 지금은 제목 유사도로만 판정하고, 준비된 문구로 훈수해요. 누르면 설정이 열립니다.`
  }
  return `${head} · 빠른 판정은 정상 동작 중이에요. 정밀 판정 없이 준비된 문구로 훈수해요. 누르면 설정이 열립니다.`
}

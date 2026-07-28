// Style dice for the session recap. The model cannot roll randomness itself (and
// temperature alone only varies the wording, not the framing), so the extension rolls the
// dice and ships the result in the payload — the prompt tells the writer to honor them.
// Pure; inject `rand` for deterministic tests.

export const SUMMARY_FOCI = ["top_page", "ratio", "leaked_time", "nag_response"] as const
export const SUMMARY_CLOSINGS = ["question", "next_suggestion", "verdict"] as const
export const BONUS_CHANCE = 0.1

export type SummaryFocus = (typeof SUMMARY_FOCI)[number]
export type SummaryClosing = (typeof SUMMARY_CLOSINGS)[number]

export interface SummaryDice {
  focus: SummaryFocus // which angle the recap is built around
  closing: SummaryClosing // how the recap ends
  bonus: boolean // rare: one extra flavor sentence allowed (sentence cap 3 → 4)
}

function pick<T>(pool: readonly T[], rand: () => number): T {
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}

export function rollSummaryDice(rand: () => number = Math.random): SummaryDice {
  return {
    focus: pick(SUMMARY_FOCI, rand),
    closing: pick(SUMMARY_CLOSINGS, rand),
    bonus: rand() < BONUS_CHANCE,
  }
}

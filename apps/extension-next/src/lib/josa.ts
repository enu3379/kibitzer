// Korean particle (조사) selection for persona template fills. Fallback/celebrate
// templates attach batchim-dependent particles right after a placeholder ("{goal}이",
// "{goal}은", "{host}로"), so a naive substitution produces "뉴스보기이 안 보인다".
// resolveJosa picks the allomorph that agrees with the substituted value's final sound.
// The particle table is scoped to spellings that appear (or can appear) directly after
// a template placeholder — it is not a general-purpose morphological analyzer.

export interface WordEnding {
  batchim: boolean
  /** ㄹ 받침 — takes 로, not 으로 (서울로). */
  rieul: boolean
}

const HANGUL_BASE = 0xac00
const HANGUL_LAST = 0xd7a3
const RIEUL_JONG = 8

// Digits by their Korean readings 영일이삼사오육칠팔구: batchim on 0,1,3,6,7,8; ㄹ on 1,7,8.
const DIGIT_BATCHIM = new Set(["0", "1", "3", "6", "7", "8"])
const DIGIT_RIEUL = new Set(["1", "7", "8"])

// Latin letters whose Korean letter names end in a consonant: 엘, 엠, 엔, 알.
const LATIN_BATCHIM = new Set(["l", "m", "n", "r"])
const LATIN_RIEUL = new Set(["l", "r"])

/** Ending of the last sound-bearing char (Hangul syllable, Latin letter, or digit),
 *  skipping trailing quotes/punctuation. Null when no such char exists — callers
 *  should then leave the template's particle as written. */
export function wordEnding(value: string): WordEnding | null {
  const chars = Array.from(value)
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= HANGUL_BASE && cp <= HANGUL_LAST) {
      const jong = (cp - HANGUL_BASE) % 28
      return { batchim: jong !== 0, rieul: jong === RIEUL_JONG }
    }
    if (/[0-9]/.test(ch)) {
      return { batchim: DIGIT_BATCHIM.has(ch), rieul: DIGIT_RIEUL.has(ch) }
    }
    if (/[a-z]/i.test(ch)) {
      const lower = ch.toLowerCase()
      return { batchim: LATIN_BATCHIM.has(lower), rieul: LATIN_RIEUL.has(lower) }
    }
  }
  return null
}

type PickParticle = (ending: WordEnding) => string

const pair =
  (withBatchim: string, without: string): PickParticle =>
  (ending) =>
    ending.batchim ? withBatchim : without

const ro: PickParticle = (ending) => (ending.batchim && !ending.rieul ? "으로" : "로")

/** Particle spellings as they may appear in templates, hedged forms ("을(를)",
 *  "(으)로") included. Longest first so "이랑" wins over "이". A bare "야" resolves
 *  as the copula (~이야); templates wanting the vocative should write "아". */
const PARTICLES: ReadonlyArray<[string, PickParticle]> = [
  ["을(를)", pair("을", "를")],
  ["를(을)", pair("을", "를")],
  ["이(가)", pair("이", "가")],
  ["가(이)", pair("이", "가")],
  ["은(는)", pair("은", "는")],
  ["는(은)", pair("은", "는")],
  ["과(와)", pair("과", "와")],
  ["와(과)", pair("과", "와")],
  ["(으)로", ro],
  ["으로", ro],
  ["이랑", pair("이랑", "랑")],
  ["이잖", pair("이잖", "잖")],
  ["이라", pair("이라", "라")],
  ["이야", pair("이야", "야")],
  ["로", ro],
  ["랑", pair("이랑", "랑")],
  ["잖", pair("이잖", "잖")],
  ["라", pair("이라", "라")],
  ["야", pair("이야", "야")],
  ["이", pair("이", "가")],
  ["가", pair("이", "가")],
  ["은", pair("은", "는")],
  ["는", pair("은", "는")],
  ["을", pair("을", "를")],
  ["를", pair("을", "를")],
  ["과", pair("과", "와")],
  ["와", pair("과", "와")],
]

export interface JosaMatch {
  /** The correctly agreeing allomorph to emit in place of the template's spelling. */
  particle: string
  /** How many chars of the template the matched spelling occupies. */
  consumed: number
}

/** If `following` (template text right after a substituted placeholder) starts with
 *  an alternating particle, return the allomorph agreeing with `value`. Null when the
 *  ending is undeterminable or no particle follows — leave the template untouched. */
export function resolveJosa(value: string, following: string): JosaMatch | null {
  const ending = wordEnding(value)
  if (!ending) return null
  for (const [spelling, pick] of PARTICLES) {
    if (following.startsWith(spelling)) {
      return { particle: pick(ending), consumed: spelling.length }
    }
  }
  return null
}

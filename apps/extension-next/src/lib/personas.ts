// Persona layer for the Tier-2 Message Writer. Mirrors apps/server/app/core/personas.py:
// the judge (decideTier2) is persona-independent; the writer's system prompt is the base
// Writer contract + the selected persona's style layer. Templates are the offline fallback.

import { TIER2_WRITER_SYSTEM_PROMPT } from "../providers/prompts.ts"
import { PERSONA_DEFAULT, PERSONA_ORDER, PERSONAS, type PersonaData } from "./personas.data.ts"

export type { PersonaData }
export { PERSONA_DEFAULT, PERSONA_ORDER, PERSONAS }

const PERSONA_KEY = "kibitzer:persona:v1"

/** The persona key the user picked (defaults to dry_kibitzer). */
export async function getPersonaKey(): Promise<string> {
  const stored = await chrome.storage.local.get(PERSONA_KEY)
  const key = stored[PERSONA_KEY]
  return typeof key === "string" && key in PERSONAS ? key : PERSONA_DEFAULT
}

export async function setPersonaKey(key: string): Promise<string> {
  const resolved = typeof key === "string" && key in PERSONAS ? key : PERSONA_DEFAULT
  await chrome.storage.local.set({ [PERSONA_KEY]: resolved })
  return resolved
}

export function resolvePersona(key: string): PersonaData {
  return PERSONAS[key] ?? PERSONAS[PERSONA_DEFAULT]
}

export async function activePersona(): Promise<PersonaData> {
  return resolvePersona(await getPersonaKey())
}

/** {key,name} pairs in display order — for the popup picker. */
export function personaChoices(): Array<{ key: string; name: string }> {
  return PERSONA_ORDER.map((key) => ({ key, name: PERSONAS[key]?.name ?? key }))
}

/** Base Writer contract + persona style layer. Matches the server's
 *  compose_tier2_writer_system_prompt (voice/tone/forbidden expressions live here). */
export function composeWriterPrompt(persona: PersonaData | null): string {
  const style = persona?.stylePrompt.trim()
  if (!style) return TIER2_WRITER_SYSTEM_PROMPT
  return (
    `${TIER2_WRITER_SYSTEM_PROMPT}\n\n` +
    "The persona style layer below owns voice, tone, and forbidden expressions.\n" +
    `Persona style layer:\n${style}`
  )
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  )
}

/** Offline nag message when the Writer is unavailable. Indexed by nag ordinal, cyclic
 *  (matches format_persona_fallback). Returns null if the persona has no templates. */
export function pickFallback(
  persona: PersonaData,
  nagCount: number,
  values: { goal: string; title: string; host: string },
): string | null {
  const pool = persona.fallbackTemplates
  if (pool.length === 0) return null
  const template = pool[Math.max(0, nagCount - 1) % pool.length]
  return fill(template, { ...values, nag_count: String(nagCount) })
}

/** Celebration message on drift-departure → return; picked at random (matches server). */
export function pickCelebrate(
  persona: PersonaData,
  values: { goal: string; returnMinutes: number },
): string | null {
  const pool = persona.celebrateTemplates
  if (pool.length === 0) return null
  const template = pool[Math.floor(Math.random() * pool.length)]
  return fill(template, { goal: values.goal, return_minutes: String(values.returnMinutes) })
}

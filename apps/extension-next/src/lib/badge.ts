// Toolbar action status — a plain coloured dot composited onto the action icon (the
// serverless analog of the old extension's applyStatusIcon). Driven from the gauge state
// on every dispatch. Chrome's native badge always renders a rounded box behind its text,
// so a bare dot has to be drawn into the icon itself (OffscreenCanvas → setIcon); the
// native "●" badge survives only as a fallback when icon drawing is unavailable
// (draw failure, or Node test runs where OffscreenCanvas doesn't exist).

import type { GaugeState } from "../core/gauge/types.ts"
import type { SessionGoal } from "./session.ts"

const GREEN = "#1f9d6b" // focused
const AMBER = "#e0a100" // slipping
const RED = "#d1495b" // drifting
const GREY = "#8a8a90" // snoozed

const ICON_SIZES = [16, 32] as const

let baseIcons: Map<number, ImageBitmap> | null = null

async function loadBaseIcons(): Promise<Map<number, ImageBitmap>> {
  if (baseIcons) return baseIcons
  const map = new Map<number, ImageBitmap>()
  for (const size of ICON_SIZES) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`))).blob()
    map.set(size, await createImageBitmap(blob))
  }
  baseIcons = map
  return map
}

function drawStatusDot(ctx: OffscreenCanvasRenderingContext2D, size: number, color: string): void {
  const r = Math.max(3, size * 0.2)
  ctx.beginPath()
  ctx.arc(size - r, r, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

// Draws are async while callers are fire-and-forget, so a slow older draw must not
// clobber a newer one: only the call holding the latest token gets to setIcon.
let drawToken = 0

async function applyStatusIcon(color: string | null): Promise<void> {
  const token = ++drawToken
  const bases = await loadBaseIcons()
  const imageData: Record<number, ImageData> = {}
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("no 2d context")
    const base = bases.get(size)
    if (base) ctx.drawImage(base, 0, 0, size, size)
    if (color) drawStatusDot(ctx, size, color)
    imageData[size] = ctx.getImageData(0, 0, size, size)
  }
  if (token !== drawToken) return
  await chrome.action.setIcon({ imageData })
  await chrome.action.setBadgeText({ text: "" }) // keep the native badge box off
}

function renderNativeBadge(color: string | null): void {
  try {
    void chrome.action.setBadgeText({ text: color ? "●" : "" })
    if (color) void chrome.action.setBadgeBackgroundColor({ color })
  } catch {
    // action API unavailable — nothing to do.
  }
}

function render(color: string | null): void {
  if (typeof OffscreenCanvas === "undefined") return renderNativeBadge(color)
  void applyStatusIcon(color).catch(() => renderNativeBadge(color))
}

export function updateBadge(state: GaugeState, goal: SessionGoal | null, now: number): void {
  if (!goal) return clearBadge()
  let color = GREEN
  if (state.snoozedUntil && state.snoozedUntil > now) color = GREY
  else if (state.s < 33) color = RED
  else if (state.s < 66) color = AMBER
  render(color)
}

export function clearBadge(): void {
  render(null)
}

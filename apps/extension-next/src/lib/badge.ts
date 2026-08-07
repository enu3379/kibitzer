// Toolbar action status — a plain coloured dot composited onto the action icon (the
// serverless analog of the old extension's applyStatusIcon). Driven from the gauge state
// on every dispatch. Chrome's native badge always renders a rounded box behind its text,
// so a bare dot has to be drawn into the icon itself (OffscreenCanvas → setIcon); the
// native "●" badge survives only as a fallback when icon drawing is unavailable
// (draw failure, or Node test runs where OffscreenCanvas doesn't exist).

import type { GaugeState } from "../core/gauge/types.ts"
import type { SessionGoal } from "./session.ts"
import { getProviderHealth } from "./providerHealth.ts"
import { providerAlertLevel } from "./providerHealthView.ts"

const GREEN = "#1f9d6b" // focused
const AMBER = "#e0a100" // slipping
const RED = "#d1495b" // drifting
const GREY = "#8a8a90" // snoozed
// Provider-error mark (top-left, opposite the status dot): red = Tier 2 down (nags lose
// their judge), amber = only Tier 1 down (false-positive filter gone). Red wins.
const ALERT_COLOR = { red: "#d1495b", amber: AMBER } as const

type AlertLevel = keyof typeof ALERT_COLOR

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

/** Small "!" in a coloured disc at the TOP-LEFT corner (the status dot owns the
 *  top-right): an LLM tier is failing. Drawn geometrically — text glyphs smear at 16px. */
function drawProviderAlert(ctx: OffscreenCanvasRenderingContext2D, size: number, color: string): void {
  const r = Math.max(3.5, size * 0.22)
  const cx = r
  const cy = r
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.fillStyle = "#ffffff"
  const w = Math.max(1, r * 0.32)
  ctx.fillRect(cx - w / 2, cy - r * 0.62, w, r * 0.9)
  ctx.beginPath()
  ctx.arc(cx, cy + r * 0.55, w * 0.62, 0, Math.PI * 2)
  ctx.fill()
}

// Draws are async while callers are fire-and-forget, so a slow older draw must not
// clobber a newer one: only the call holding the latest token gets to setIcon.
let drawToken = 0

async function applyStatusIcon(color: string | null, alert: AlertLevel | null): Promise<void> {
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
    if (alert) drawProviderAlert(ctx, size, ALERT_COLOR[alert])
    imageData[size] = ctx.getImageData(0, 0, size, size)
  }
  if (token !== drawToken) return
  await chrome.action.setIcon({ imageData })
  await chrome.action.setBadgeText({ text: "" }) // keep the native badge box off
}

function renderNativeBadge(color: string | null, alert: AlertLevel | null): void {
  try {
    // The native fallback has one slot — the error mark outranks the status dot, with
    // the same red-over-amber priority the drawn mark has.
    void chrome.action.setBadgeText({ text: alert ? "!" : color ? "●" : "" })
    const badgeColor = alert ? ALERT_COLOR[alert] : color
    if (badgeColor) void chrome.action.setBadgeBackgroundColor({ color: badgeColor })
  } catch {
    // action API unavailable — nothing to do.
  }
}

function render(color: string | null, alert: AlertLevel | null): void {
  if (typeof OffscreenCanvas === "undefined") return renderNativeBadge(color, alert)
  void applyStatusIcon(color, alert).catch(() => renderNativeBadge(color, alert))
}

// drawToken only serializes draws by the order render() was ENTERED — but each
// updateBadge waits on a storage read first, so an older call whose read resolves late
// would start its render after a newer one and win the token. Gate on the dispatch
// order instead: only the latest updateBadge/clearBadge may render at all.
let badgeRevision = 0

export function updateBadge(state: GaugeState, goal: SessionGoal | null, now: number): void {
  if (!goal) return clearBadge()
  const revision = ++badgeRevision
  let color = GREEN
  if (state.snoozedUntil && state.snoozedUntil > now) color = GREY
  else if (state.s < 33) color = RED
  else if (state.s < 66) color = AMBER
  // Provider errors ride along as a "!" mark until a call succeeds, settings change, or
  // the record expires (getProviderHealth drops expired records — same cut as the popup).
  void getProviderHealth()
    .then((health) => {
      if (revision === badgeRevision) render(color, providerAlertLevel(health))
    })
    .catch(() => {
      if (revision === badgeRevision) render(color, null)
    })
}

export function clearBadge(): void {
  badgeRevision += 1 // a pending health lookup must not repaint a cleared badge
  render(null, null)
}

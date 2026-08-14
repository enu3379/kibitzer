// Sundial time visual: a sprout lit by the sun (rides a dome start→end) casting a shadow
// whose length/direction tells how far the session has run. Monochrome but for the leaves.
// Pure SVG-string renderer (frac ∈ [0, 1] = elapsed share of the session budget), shared
// by the popup (live) and the onboarding wizard (illustration). Colours come from the
// host page's --sd-* custom properties.
// Past the budget the sun is done and the moon takes the same dome (night: dimmer light, stars).
export function sundialSVG(frac: number, night = false): string {
  const cx = 62, gy = 62, rx = 48, ry = 46, n = 48
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) {
    const t = Math.PI * (1 - i / n)
    pts.push([cx + rx * Math.cos(t), gy - ry * Math.sin(t)])
  }
  const k = Math.round(frac * n)
  const [sx, sy] = pts[k]
  const objH = 22, base = gy - objH + 6, pw = 13, ptop = gy - 8
  const leaf = (deg: number, len: number, wid: number) => {
    const a = (deg * Math.PI) / 180, tx = cx + len * Math.cos(a), ty = base + len * Math.sin(a)
    const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2)
    const mx = (cx + tx) / 2, my = (base + ty) / 2
    const d = `M${cx.toFixed(1)},${base.toFixed(1)} Q${(mx + px * wid).toFixed(1)},${(my + py * wid).toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)} Q${(mx - px * wid).toFixed(1)},${(my - py * wid).toFixed(1)} ${cx.toFixed(1)},${base.toFixed(1)} Z`
    return `<path d="${d}" fill="var(--sd-leaf)"/><path d="M${cx.toFixed(1)},${base.toFixed(1)} L${tx.toFixed(1)},${ty.toFixed(1)}" stroke="var(--sd-bg)" stroke-width="0.8" stroke-linecap="round" opacity="0.5"/>`
  }
  const sprout =
    `<path d="M${cx - pw / 2},${ptop} L${cx + pw / 2},${ptop} L${cx + pw / 2 - 2},${gy} L${cx - pw / 2 + 2},${gy} Z" fill="var(--sd-ink)"/>` +
    `<path d="M${cx},${ptop} L${cx},${base}" stroke="var(--sd-ink)" stroke-width="1.7" stroke-linecap="round"/>` +
    leaf(-152, 13.5, 3) + leaf(-44, 12.5, 2.8)
  const aimY = gy - objH * 0.7
  const d = Math.hypot(cx - sx, aimY - sy), phi = Math.atan2(aimY - sy, cx - sx), hw = (15 * Math.PI) / 180, r = d * 1.06
  const b1x = sx + r * Math.cos(phi - hw), b1y = sy + r * Math.sin(phi - hw)
  const b2x = sx + r * Math.cos(phi + hw), b2y = sy + r * Math.sin(phi + hw)
  const dir = sx >= cx ? -1 : 1
  const elev = Math.atan2(gy - sy, Math.abs(sx - cx) + 0.5)
  const L = Math.min(44, objH / Math.tan(elev) + 4)
  let rays = ""
  if (!night)
    for (let a = 0; a < 8; a++) {
      const q = (a * Math.PI) / 4
      rays += `<line x1="${(sx + 7 * Math.cos(q)).toFixed(1)}" y1="${(sy + 7 * Math.sin(q)).toFixed(1)}" x2="${(sx + 9.5 * Math.cos(q)).toFixed(1)}" y2="${(sy + 9.5 * Math.sin(q)).toFixed(1)}" stroke="var(--sd-ink)" stroke-width="1.2" stroke-linecap="round"/>`
    }
  const stars = night
    ? `<circle cx="24" cy="14" r="1.1" fill="var(--sd-ink3)" opacity="0.7"/>
    <circle cx="44" cy="10" r="1.1" fill="var(--sd-ink3)" opacity="0.7"/>
    <path d="M96,9 L96,15 M93,12 L99,12" stroke="var(--sd-ink3)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>`
    : ""
  const orb = night
    ? `<mask id="kbzmoon"><rect x="0" y="0" width="124" height="78" fill="#fff"/><circle cx="${(sx + 3.2).toFixed(1)}" cy="${(sy - 1.6).toFixed(1)}" r="4.4" fill="#000"/></mask>` +
      `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="var(--sd-ink)" mask="url(#kbzmoon)"/>`
    : `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="var(--sd-ink)"/>`
  const beamMid = night ? 0.1 : 0.19, shadowOp = night ? 0.15 : 0.26
  return `<svg width="124" height="78" viewBox="0 0 124 78" role="img" aria-label="${night ? "시간 경과 (목표 시간 초과)" : "시간 경과"}">
    <defs><radialGradient id="kbzbeam" gradientUnits="userSpaceOnUse" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(1)}">
      <stop offset="0.12" stop-color="var(--sd-ink)" stop-opacity="0.03"/>
      <stop offset="0.6" stop-color="var(--sd-ink)" stop-opacity="${beamMid}"/>
      <stop offset="1" stop-color="var(--sd-ink)" stop-opacity="0"/></radialGradient></defs>
    <polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="var(--sd-line)" stroke-width="1.5" stroke-dasharray="1 4" stroke-linecap="round"/>
    <line x1="8" y1="${gy}" x2="116" y2="${gy}" stroke="var(--sd-line)" stroke-width="1"/>
    <ellipse cx="${(cx + dir * L * 0.42).toFixed(1)}" cy="${(gy + 1.5).toFixed(1)}" rx="${(L * 0.48 + 5).toFixed(1)}" ry="4.8" fill="var(--sd-ink3)" opacity="${shadowOp}"/>
    <path d="M${sx.toFixed(1)},${sy.toFixed(1)} L${b1x.toFixed(1)},${b1y.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${b2x.toFixed(1)},${b2y.toFixed(1)} Z" fill="url(#kbzbeam)"/>
    ${stars}${sprout}
    ${rays}${orb}
  </svg>`
}

export interface PageExcerpt {
  title: string
  text: string
}

export function extractPageExcerpt(limit: number): PageExcerpt {
  const title = document.title
  const root = document.querySelector("main, article") ?? document.body
  // textContent includes <style>/<script> bodies, which produced excerpts that
  // were pure CSS on some pages and misled Tier 2. Strip them from a clone.
  const clone = (root?.cloneNode(true) ?? null) as HTMLElement | null
  clone?.querySelectorAll("script, style, noscript, svg, template").forEach((node) => {
    node.remove()
  })
  const text = (clone?.textContent ?? "").replace(/\s+/g, " ").trim()
  return {
    title,
    text: text.slice(0, limit),
  }
}

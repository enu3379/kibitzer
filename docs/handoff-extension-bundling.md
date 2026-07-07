# Handoff: Chrome Extension Build Pipeline

Date: 2026-07-05
Scope owner: delegated agent (Codex)
Repo root: this repository (`kibitzer`)

## Goal

Make the Chrome MV3 extension in `apps/extension/` actually loadable in Chrome via "Load unpacked". Today it cannot load at all.

## Problem statement (verified facts)

- `apps/extension/manifest.json` points the service worker at `src/background.ts`. Chrome cannot load TypeScript.
- `apps/extension/package.json` has `"build": "tsc --noEmit"` — type-check only, no JS is ever emitted. There is no bundler and no `dist/` directory.
- `apps/extension/src/background.ts` imports three local modules (`./content/readabilityExtract`, `./lib/api`, `./lib/domainFilter`). There are zero runtime npm dependencies.
- All prior "extension build passes" verification in `docs/progress.md` means type-checking only. No real browser E2E has ever run.

## Deliverable

A build step that produces a self-contained `dist/` directory which Chrome can load unpacked.

### Target `dist/` layout

```text
apps/extension/dist/
  manifest.json        copied verbatim from apps/extension/manifest.json
  background.js        bundled from src/background.ts
  popup/popup.html     copied from src/popup/popup.html
  icons/icon-128.svg   copied from icons/
```

## Required changes

1. Add `esbuild` as a devDependency (`npm i -D esbuild`, run in `apps/extension/`).

2. Create `apps/extension/build.mjs`. Reference implementation (adapt as needed):

```js
import { build, context } from "esbuild"
import { cpSync, mkdirSync } from "node:fs"

const watch = process.argv.includes("--watch")

const options = {
  entryPoints: ["src/background.ts"],
  outfile: "dist/background.js",
  bundle: true,
  format: "esm",
  target: "chrome120",
  minify: false,
  sourcemap: false,
}

function copyStatic() {
  mkdirSync("dist/popup", { recursive: true })
  cpSync("manifest.json", "dist/manifest.json")
  cpSync("src/popup/popup.html", "dist/popup/popup.html")
  cpSync("icons", "dist/icons", { recursive: true })
}

if (watch) {
  const ctx = await context(options)
  copyStatic()
  await ctx.watch()
} else {
  await build(options)
  copyStatic()
}
```

3. Update `apps/extension/manifest.json` so paths are correct **relative to `dist/`**:
   - `background.service_worker`: `"background.js"`
   - `action.default_popup`: `"popup/popup.html"`
   - Keep `"type": "module"` (the esm bundle has no import statements, so a module service worker loads fine).
   - Do not touch `permissions` or `host_permissions`.

4. Update `apps/extension/package.json` scripts:

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "build": "npm run typecheck && node build.mjs",
  "watch": "node build.mjs --watch",
  "test": "tsc --noEmit"
}
```

5. Update `apps/extension/README.md`: document `npm install`, `npm run build`, `npm run watch`, and how to load `apps/extension/dist` via `chrome://extensions` → Developer mode → Load unpacked.

6. Append a short entry to `docs/progress.md` noting the extension now builds to a loadable `dist/` bundle.

## Hard constraints

- **`minify` must stay `false`.** `background.ts` passes `extractPageExcerpt` as `func:` to `chrome.scripting.executeScript`. Chrome serializes that function with `toString()` and injects the source text into the page. The function must survive bundling as one self-contained function body.
- **Do not refactor `src/content/readabilityExtract.ts`.** `extractPageExcerpt` must not be split into helpers or reference anything outside its own body, or runtime injection breaks silently.
- **Do not convert the SVG icon to PNG.** A separate task will replace icons (Chrome notifications don't render SVG `iconUrl`; that is a known issue, out of scope here). Just copy `icons/` as-is so `chrome.runtime.getURL` resolves.
- No new extension permissions, no server-side changes, no UI frameworks, no other new dependencies.
- `dist/` stays untracked (already covered by the root `.gitignore`).

## Acceptance checks (run all)

From `apps/extension/`:

```bash
npm install
npm run build
test -f dist/manifest.json && test -f dist/background.js \
  && test -f dist/popup/popup.html && test -f dist/icons/icon-128.svg && echo LAYOUT_OK
grep -c "import " dist/background.js          # expect 0 (fully bundled)
grep -c "querySelector(\"main, article\")" dist/background.js   # expect >= 1 (excerpt fn inlined intact)
grep -c "background.js" dist/manifest.json    # expect 1
npx tsc --noEmit && echo TYPECHECK_OK
git status --porcelain | grep dist && echo "FAIL: dist tracked" || echo GITIGNORE_OK
```

## Manual follow-up (for the human, not the agent)

- Load `apps/extension/dist` unpacked in Chrome and confirm the service worker registers without errors.
- Known issue to expect: notifications may show without an icon until the PNG icon task lands. Do not fix in this task.

## Context notes

- `tsconfig.json` already uses `"moduleResolution": "Bundler"` — no tsconfig changes needed.
- `apps/extension/public/` exists but is empty and unused; leave it alone.
- A popup script (`src/popup/popup.ts`) and PNG icons will be added in separate follow-up tasks by another agent. Do not prepare for them (no second entry point, no placeholder files) — `build.mjs` will gain a popup entry then. Keep your changes minimal so the follow-up merge is clean.
- The local server the extension talks to runs at `http://127.0.0.1:8765` (see `configs/default.yaml`); not needed for this task.

# Kibitzer Chrome Extension

The extension is a Chrome MV3 event relay and delivery surface.

## Build

Install dependencies:

```bash
npm install
```

Build a Chrome-loadable bundle:

```bash
npm run build
```

This writes `dist/` with:

```text
dist/
  manifest.json
  background.js
  popup/popup.html
  popup/popup.js
  icons/icon-16.png ... icon-128.png (plus the source icon-128.svg)
```

For development rebuilds:

```bash
npm run watch
```

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `apps/extension/dist`.

## Responsibilities

- observe active-tab navigation
- handle SPA URL updates
- debounce title capture
- perform first-pass sensitive-domain drop
- call the local server
- run Readability excerpt extraction only when requested
- show Chrome notifications
- send feedback button clicks to the server
- popup for declaring the goal and viewing session state, streak, and stats
- popup snooze / resume / end-session controls with an end-of-session summary
- toolbar status dot (small pip at the icon's top-right, drawn onto the icon; the native text badge is disabled): orange = no session/goal, red = pending nudge, blue = snoozed, gray = server unreachable, none = tracking cleanly

## Non-responsibilities

- session state
- relevance judgment
- controller decisions
- durable logs

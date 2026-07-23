# Extension Source

`background.ts` observes browser events and sends them to the local server.

`content/` contains injected-on-request code: excerpt extraction and the
in-page toast delivery surface.

`popup/` contains goal/session controls.

`lib/` contains shared API and privacy helpers. `lib/gaugeShadow.ts` is the
Phase 2 diagnostic runner: it persists reducer state in `chrome.storage.session`
and records effects without delivering them.

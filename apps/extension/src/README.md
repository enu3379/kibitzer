# Extension Source

`background.ts` observes browser events and sends them to the local server.

`content/` contains injected-on-request code: excerpt extraction and the
in-page toast delivery surface.

`popup/` contains goal/session controls.

`lib/` contains shared API and privacy helpers. `lib/gaugeShadow.ts` serializes
gauge transitions, while `lib/gaugeIndexedDb.ts` owns the persistent checkpoint
and pending-effect outbox. Effects are recorded atomically with state but are
not delivered during shadow mode.

# Content Scripts

Content scripts run only on explicit server request.

This folder holds the two injected surfaces:

- `readabilityExtract.ts` — Readability-based page excerpt extraction,
  immediately before a potential intervention.
- `toastOverlay.ts` — the primary delivery surface: a shadow-DOM toast
  rendered into the active web page (interventions and celebrations). The
  background worker keeps pending toast metadata and reinjects the latest
  pending toast after tab activation or navigation until feedback, dismissal, or
  expiry.

Do not collect page body continuously.

## Known Polish Notes

- Toast card sizing can vary slightly by tab/site. The cause is not yet known;
  it is not blocking the redisplay behavior.
- When a pending toast is reinjected while switching tabs, Kibitzer's entrance
  animation runs again. This is acceptable for now and can be polished later.

# Content Scripts

Content scripts run only on explicit server request.

This folder holds the two injected surfaces:

- `readabilityExtract.ts` — Readability-based page excerpt extraction,
  immediately before a potential intervention.
- `toastOverlay.ts` — the primary delivery surface: a shadow-DOM toast
  rendered in the observed tab (interventions and celebrations).

Do not collect page body continuously.


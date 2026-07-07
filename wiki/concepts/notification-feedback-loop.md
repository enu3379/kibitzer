---
type: concept
title: Notification Feedback Loop
tags: [feedback, notification, controller]
related: [tiered-drift-judging, streak-controller, privacy-boundary]
created: 2026-07-05
updated: 2026-07-05
---

# Notification Feedback Loop

Work Package 9 connects confirmed interventions to user feedback.

After Tier 2 returns `notify`, the server creates an intervention and the Chrome extension shows a notification. The extension keeps the intervention id and observation id in service-worker memory for the notification lifetime.

The notification actions are:

- `related`: the page was useful for the declared goal. The server adds the observation embedding to session goal exemplars, with cap enforcement.
- `accepted`: the drift warning was useful. The server marks the intervention accepted.
- `snooze`: the user wants quiet time. The server updates controller `snoozed_until`, while later observations are still logged.

Feedback is duplicate-safe per intervention/kind, so repeated button events do not add duplicate exemplars or repeat side effects.

The loop preserves the privacy boundary: feedback events contain ids and kinds, not raw page excerpts.

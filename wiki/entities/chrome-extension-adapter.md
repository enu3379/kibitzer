---
type: entity
title: Chrome Extension Adapter
tags: [chrome, mv3, adapter]
related: [observation-pipeline, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Chrome Extension Adapter

The Chrome extension observes active-tab navigation and relays normalized browser events to the local server.

It handles:

- `webNavigation.onCommitted`
- `webNavigation.onHistoryStateUpdated`
- `tabs.onActivated`
- title debounce
- first-pass sensitive-domain drop
- requested-only Readability excerpt extraction
- notification delivery and feedback buttons

It does not own durable session state.


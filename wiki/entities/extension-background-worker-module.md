---
type: entity
title: Extension Background Worker Module
tags: [code-map, extension, chrome, mv3]
related: [chrome-extension-adapter, observation-pipeline, privacy-boundary]
created: 2026-07-03
updated: 2026-07-03
---

# Extension Background Worker Module

This module group observes browser navigation and relays events to the local server.

## Responsibilities

- listen to Chrome navigation events
- debounce tab title capture
- send browser navigation payloads to the server
- avoid durable state in the MV3 service worker

## Files

- `apps/extension/src/background.ts`
- `apps/extension/src/lib/api.ts`
- `apps/extension/src/content/readabilityExtract.ts`
- `apps/extension/manifest.json`

## Linked Concepts

- [[chrome-extension-adapter]]
- [[observation-pipeline]]
- [[privacy-boundary]]


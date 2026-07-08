# PR: Add Popup Exploration History Diagnostics

## Summary

- Add a popup `탐색 기록` view for recent active-tab pages seen by the extension.
- Store exploration history in `chrome.storage.session`, capped at 100 entries and cleared with the browser session.
- Show judgment status lights for pages that reached drift judging.

## User-Facing Changes

- The popup dashboard now has a `탐색 기록` button.
- Each history row shows:
  - page title, or host fallback when the title is unavailable;
  - full URL in small muted text;
  - green light for `OK`, amber drift light for `DRIFT`, and no light when the page did not reach judgment.

## Privacy Notes

- History is stored only in Chrome extension session storage, not in the server SQLite database.
- Sensitive-domain pre-drop remains in place; blocked URLs are not added to exploration history.
- Full URLs are shown for allowed pages because this is an explicit local debug surface.
- Page body collection is unchanged: excerpts are still requested only after the controller asks for Tier 2 confirmation.

## Test Plan

- `npm --prefix apps/extension run build`
- Confirm TypeScript accepts `chrome.storage.session` usage.
- Manual:
  - Visit a page briefly and confirm it appears without a light.
  - Stay on an on-goal page past the judgment dwell gate and confirm a green light.
  - Stay on a drift page past the judgment dwell gate and confirm an amber drift light.
  - Restart Chrome and confirm the exploration history is cleared.
  - Visit a sensitive-domain URL and confirm it is not shown in history.

## Follow-Up

- Add richer diagnostics to each judged row once audit routing lands: `r0`, `tier_reached`, audit trigger, and title-quality category.
- Consider a developer-mode toggle before exposing this view to less technical users.

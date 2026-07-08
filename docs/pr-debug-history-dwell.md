# PR: Add Popup Exploration History And Configurable Dwell Gates

## Summary

- Add a popup `탐색 기록` view for recent browser pages seen by the extension.
- Store exploration history in `chrome.storage.session`, capped at 100 entries and cleared with the browser session.
- Make both dwell gates user-configurable from popup settings:
  - `판정 대기`: delay before a navigation is sent for drift judgment.
  - `본문 확인 대기`: total same-page dwell required before Tier 2 excerpt extraction.

## User-Facing Changes

- The popup dashboard now has a `탐색 기록` button.
- Each history row shows:
  - page title, or host fallback when the title is unavailable;
  - full URL in small muted text;
  - green light for `OK`, amber drift light for `DRIFT`, and no light when the page did not reach judgment.
- Settings now include two second-based inputs for the observation and Tier 2 dwell thresholds.

## Privacy Notes

- History is stored only in Chrome extension session storage, not in the server SQLite database.
- Sensitive-domain pre-drop remains in place; blocked URLs are not added to exploration history.
- Full URLs are shown for allowed pages because this is an explicit local debug surface.
- Page body collection is unchanged: excerpts are still requested only after the controller asks for Tier 2 confirmation.

## Test Plan

- Server:
  - `python -m pytest apps/server/tests/test_settings_api.py -q`
  - Confirm `/settings` returns default dwell values.
  - Confirm `PUT /settings` round-trips `observation_seconds` and `tier2_seconds`.
  - Confirm invalid dwell values outside `1..300` are rejected.
- Extension:
  - `npm --prefix apps/extension run build`
  - Confirm TypeScript accepts `chrome.storage.session` usage.
- Manual:
  - Set `판정 대기` to 3 seconds, visit a page for less than 3 seconds, and confirm it appears without a light.
  - Stay on an on-goal page past the threshold and confirm a green light.
  - Stay on a drift page past the threshold and confirm an amber drift light.
  - Lower `본문 확인 대기` and confirm Tier 2 waits for the configured total same-page dwell.
  - Restart Chrome and confirm the exploration history is cleared.
  - Visit a sensitive-domain URL and confirm it is not shown in history.

## Follow-Up

- Add richer diagnostics to each judged row once audit routing lands: `r0`, `tier_reached`, audit trigger, and title-quality category.
- Consider a developer-mode toggle before exposing this view to less technical users.

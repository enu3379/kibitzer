# Privacy

## Principles

- Drop sensitive domains before creating observations.
- Never collect page body continuously. D7 retains at most one bounded
  excerpt per observation after a qualifying navigation dwell. A failed post
  may be retried once on the next heartbeat, but heartbeats do not otherwise
  recapture content.
- With D7 enabled, retain only the bounded current/recent excerpt window
  required for a time-budget Tier 2 comparison; prune older entries locally
  and never put excerpt text in events, reports, or feedback.
- Never persist raw URL paths, query strings, or fragments.
- Store the full page location only as an opaque hash.
- Keep feedback and derived vectors, not raw browsing content.

## Sensitive Domain Examples

The default list blocks:

- banking
- medical portals
- payment and checkout
- password and auth pages
- cloud console secrets pages
- local admin consoles

Both extension and server enforce this. The server gate is authoritative.

## API Payload Boundaries

Tier 1 API sees titles and hosts only.

The Tier 2 Context Judge sees bounded current/recent excerpts only when D7's
elapsed-time review is due. The conditional persona Writer never receives page
body or recent excerpt text; it sees only the current title/host, the accepted
decision, time state, and nagging context. The server applies the authoritative
sensitive-domain gate before an observation can accept content.

## Local Data Deletion

**설정 → 저장된 활동 데이터 → 모두 삭제** removes sessions, goals,
observations, feedback, intervention messages, event-log rows, idempotency
response records, the extension's temporary activity state, popup snapshot,
and outstanding Kibitzer notifications. Runtime settings remain available.

SQLite secure deletion is enabled so future row deletions overwrite deleted
content in database pages. Filesystem snapshots, backups, and SSD wear-leveling
remain outside Kibitzer's deletion guarantee. Kibitzer does not automatically
expire activity data; automatic retention needs a separate product decision
because replay and future usage analysis depend on that history.

## Failure Mode

If a domain is mistakenly allowed, the server still persists only an opaque
location hash and caps the small local content window. Sensitive domain rules
should be updated in config, not patched into code.

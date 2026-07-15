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
- Remove raw path, query strings, fragments, and URL credentials before the
  extension sends a navigation to the localhost server.
- Store only a pairing-keyed HMAC page-location identity so query-only
  navigation can be distinguished without retaining or dictionary-guessing
  the raw location.
- Keep feedback and derived vectors, not raw browsing content.

## Sensitive Domain Examples

The default list blocks:

- banking
- medical portals
- payment and checkout
- password and auth pages
- cloud console secrets pages
- local admin consoles

The extension evaluates the full URL before minimizing it for localhost; the
server independently rechecks the host and protects direct API clients. Both
consume `configs/sensitive_domains.json`, so privacy rules cannot silently
diverge between the two gates.

## API Payload Boundaries

The FastAPI server is local, but Tier 1 and Tier 2 judge providers may be cloud
services. When a cloud provider is configured, browsing-derived data leaves the
machine over HTTPS.

Tier 1 sees the declared goal, optional derived goal phrases, current title and
host, and a bounded list of recent titles and verdicts.

Tier 2 sees the declared goal, current title and host, score/verdict context,
recent titles and verdicts, and bounded current/recent excerpts only after
drift has accumulated and D7's elapsed-time review is due. The server applies
the authoritative sensitive-domain gate before an observation can accept
content. Raw excerpts remain only in the bounded local content window and are
not copied into events, reports, or feedback.

Disable `tier1.enabled` and `tier2.enabled` to keep judgment entirely local.
Configuring external provider credentials is an explicit opt-in to the fields
listed above. The first-run pairing screen repeats this disclosure and requires
acknowledgment before it stores the local API key.

## Local Retention

By default, server startup and a daily maintenance task remove activity older
than 30 days, including old closed sessions and time-stamped records inside a
long-running active session.
Set `privacy.retention_days` to a value from 1 to 3650 days. The current active
goal and settings remain available until the session ends or the user deletes
them.

The extension keeps an origin-only exploration history in
`chrome.storage.session`; its popup snapshot may retain the current goal in
extension-local storage. **설정 → 저장된 활동 데이터 → 모두 삭제** removes all
sessions, goals, observations, messages, event-log rows, the popup snapshot,
the extension exploration history, and outstanding Kibitzer Chrome
notifications. Runtime settings and the pairing key are intentionally retained.
SQLite `secure_delete` is enabled so deleted row content is overwritten in
database pages. Filesystem snapshots, backups, SSD wear-leveling, and external
notification history remain outside Kibitzer's deletion guarantee.

## Local API Trust Boundary

The loopback server validates `Host`, requires the exact extension origin for
pairing, rejects other cross-origin browser mutations, requires JSON bodies,
and caps request sizes. On first startup it creates a private 256-bit pairing
code. The extension uses that code to establish a separate random API key
without transmitting either value in plaintext.

After pairing, every non-public API request has an HMAC, a short timestamp
window, and a single-use nonce. Every API response carries a proof bound to the
request nonce, status, and response body. This prevents a process that merely
claims port 8765 from impersonating Kibitzer and requesting page excerpts.
`/health` and `/auth/status` disclose only service/auth state and remain public.

The authentication files use owner-only POSIX modes; Windows setup and launch
scripts replace inherited ACLs on the data directory and local secret files
with the current user's ACL. Chrome local storage is restricted to trusted
extension contexts before the API key is saved. This does not defend against
malware already running as the same OS user, an administrator, a compromised Chrome profile,
or a process that can read the pairing code before it is used. Native Messaging
would offer a stronger browser-to-process launch boundary, but still would not
protect a fully compromised account.

Development uses a fixed manifest public key and exact extension id. The Chrome
Web Store public key/id must replace both configured values before the first
published build.

## Failure Mode

If a domain is mistakenly allowed, the extension still removes the raw URL
location before contacting localhost and avoids body collection unless Tier 2
is requested. The server also caps the local content window. A missing or
malformed server-side sensitive-domain rules file is a startup error rather
than silently disabling the privacy gate. Sensitive domain rules should be
updated in config, not patched into code.

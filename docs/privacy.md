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
- Strip query strings and fragments.
- Store URL path as a hash unless a future debug mode explicitly opts in.
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

Tier 2 API sees bounded current/recent excerpts only when D7's elapsed-time
review is due. The server applies the authoritative sensitive-domain gate
before an observation can accept content.

## Failure Mode

If a domain is mistakenly allowed, the server still strips query strings and
caps the small local content window. Sensitive domain rules should be updated
in config, not patched into code.

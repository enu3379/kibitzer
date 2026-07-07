# Privacy

## Principles

- Drop sensitive domains before creating observations.
- Never collect page body continuously.
- Never persist Tier 2 excerpts.
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

Tier 2 API sees a bounded excerpt only after drift has accumulated and right before speaking.

## Failure Mode

If a domain is mistakenly allowed, the server still strips query strings and avoids body collection unless Tier 2 is requested. Sensitive domain rules should be updated in config, not patched into code.


# Tiers

Judgment is split by cost and data exposure.

- Tier 0: local CPU embedding and cosine similarity
- Tier 1: cheap API classifier over minimized title/host payload
- Tier 2: rare confirmation/message call with bounded excerpt

Tier 2 is invoked only after the controller gates an intervention candidate.


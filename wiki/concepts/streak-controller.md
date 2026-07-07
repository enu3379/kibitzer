---
type: concept
title: Streak Controller
tags: [controller, stage-0]
related: [tiered-drift-judging]
created: 2026-07-03
updated: 2026-07-03
---

# Streak Controller

The Stage 0 controller intervenes only after consecutive DRIFT verdicts.

```text
OK    -> streak = 0
DRIFT -> streak += 1
```

It also enforces coldstart, cooldown, and snooze gates.

The known weakness is alternating DRIFT/OK patterns. Stage 0 accepts this to reduce false positives.


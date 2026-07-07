# 2026-07-07 Alignment/Dwell Handoff

This note captures the end state of the 2026-07-07 Kibitzer session. It is a
handoff for future work, not a new design source of truth.

## Source Of Truth

- The original implementation guideline is now preserved at
  [kibitzer-implementation-guideline.md](kibitzer-implementation-guideline.md).
- When controller behavior is ambiguous, prefer that guideline over later
  partial implementation notes.
- Important correction: A안 is **not** a recent-window DRIFT count. The original
  A안 is cumulative alignment with hysteresis:

```text
A_t = alpha * A_{t-1} + (1 - alpha) * r_t
intervene when A_t < theta_low, after coldstart/cooldown/snooze gates
recover when A_t > theta_high
```

B안 remains the Stage 0 consecutive-drift streak controller.

## Code State

Pushed to `origin/main`:

- `8eaa9e2 Add configurable drift controllers`
  - Added user-facing A/B controller settings and configurable B안 `k`.
  - Historical note: the first A안 implementation used a window count and was
    superseded by `5a44aa0`.
- `5a44aa0 Implement alignment drift controller`
  - Replaced the window-count controller with `AlignmentController`.
  - Added runtime settings for `alignment_alpha`, `theta_low`, and `theta_high`.
  - Exposed A안 score/thresholds through `/sessions/current/state`.
  - Updated popup settings so A안 shows EWMA/hysteresis knobs and B안 shows
    consecutive-drift count.
  - Saved the original guideline document under `docs/`.
- `cbd49bf Merge remote-tracking branch 'origin/main'`
  - Merged the dwell-gated navigation judging work and macOS idle daemon work
    from `origin/main`.
  - Resolved conflicts in `docs/README.md` and `apps/server/tests/test_tier1.py`.

## Runtime Behavior

Current extension navigation judging behavior:

- A browser navigation observation is posted only after the active tab remains on
  the same URL for `OBSERVATION_DWELL_MS = 5000` ms.
- If the active tab changes, the URL changes, or the URL is sensitive before
  then, the observation is dropped and the controller is not updated.
- If the server requests Tier 2 excerpt confirmation, the extension waits until
  the same page has been active for `TIER2_DWELL_MS = 10000` ms total.
- The extension rechecks that the tab is still active on the observed URL before
  excerpt extraction, before excerpt submission, and before showing a
  notification.

Current A안 controller behavior:

- `AlignmentController.update(verdict, r)` updates `A_t` once per accepted
  observation.
- If `r` is missing, it falls back to `1.0` for OK and `0.0` for DRIFT.
- Once `A_t < theta_low`, the controller arms one intervention for that drift
  episode.
- After intervention, the episode stays latched and does not repeatedly arm
  until `A_t > theta_high`.
- Feedback `related` rolls the alignment score up to `theta_high` and clears the
  latch for the session.

## Live State At Handoff

After the merge, the local server was restarted on `127.0.0.1:8765`.

Observed `/settings`:

```json
{
  "persona": "kyoto",
  "voice_enabled": false,
  "controller": {
    "type": "alignment",
    "k": 5,
    "alignment_alpha": 0.85,
    "theta_low": 0.15,
    "theta_high": 0.3
  },
  "cooldown": {
    "enabled": false,
    "seconds": 300
  },
  "quiet_hours": {
    "enabled": false,
    "start": "09:00",
    "end": "18:00"
  }
}
```

Observed `/health`:

```json
{
  "ok": true,
  "service": "kibitzer-server",
  "mode": "idle",
  "active_since": null
}
```

## Verification

Run after the final merge:

```powershell
python -m pytest
$env:Path = 'D:\Program Files;' + $env:Path; npm --prefix apps\extension run build
```

Results:

- Python server tests: `68 passed`, with the existing FastAPI TestClient
  deprecation warning.
- Extension build/typecheck: passed.
- Server restarted successfully and responded on `/settings`, `/health`, and
  `/sessions/current/state`.
- `git status --short --branch` was clean and synced with `origin/main` after
  push.

## Operational Notes

- Reload the Chrome extension after pulling this state; otherwise Chrome may keep
  running the old background service worker without dwell gating.
- A안 settings are live-editable from the popup: `alpha`, `theta_low`, and
  `theta_high`.
- B안 settings remain live-editable from the popup: consecutive drift count `k`.
- Existing stored `"window"` controller settings are treated as legacy and
  upgraded to `"alignment"` by the API/runtime settings layer.

## Next Work

- Build the replay harness before doing more controller tuning. The guideline
  explicitly says B안/A안/Page-Hinkley comparisons should happen on the same logs.
- Consider making the dwell constants configurable after observing real use.
- Keep false positives as the primary failure mode to avoid; raise cooldown,
  dwell, or thresholds before making the system more aggressive.

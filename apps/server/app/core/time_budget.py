from __future__ import annotations

from dataclasses import dataclass

from ..config import TimeBudgetConfig
from ..storage.sqlite import DriftClockStateRecord


TIER2_REVIEW_LEAD_SECONDS = 30


@dataclass(frozen=True)
class TimeBudgetThresholds:
    total_seconds: int
    per_page_seconds: int
    single_page_seconds: int


def thresholds_for_budget(
    config: TimeBudgetConfig,
    available_time_minutes: int | None,
) -> TimeBudgetThresholds:
    if available_time_minutes is None:
        total = config.fallback_total_seconds
    else:
        # Round to the nearest second once, then keep all persisted clocks as
        # integers so a threshold cannot drift across process restarts.
        total = max(
            config.min_total_seconds,
            round(available_time_minutes * 60 * config.total_fraction),
        )
    return TimeBudgetThresholds(
        total_seconds=total,
        per_page_seconds=config.per_page_seconds,
        single_page_seconds=total // 2,
    )


def mode_clock_seconds(state: DriftClockStateRecord, controller_type: str) -> int:
    if controller_type == "alignment":
        return state.cumulative_drift_seconds
    return state.continuous_drift_seconds


def review_is_due(
    state: DriftClockStateRecord,
    controller_type: str,
    thresholds: TimeBudgetThresholds,
    event_eligible: bool,
) -> bool:
    return seconds_until_review_due(state, controller_type, thresholds, event_eligible) == 0


def seconds_until_review_due(
    state: DriftClockStateRecord,
    controller_type: str,
    thresholds: TimeBudgetThresholds,
    event_eligible: bool,
) -> int | None:
    """Seconds of continued drift until every review gate can be satisfied.

    The current-page and selected mode clocks advance together while the active
    page remains DRIFT. ``None`` means no review should be scheduled from this
    event (for example, coldstart/cooldown or an in-flight review).
    """

    if (
        not event_eligible
        or state.review_observation_id is not None
        or state.active_verdict != "DRIFT"
    ):
        return None

    current_page = state.current_page_drift_seconds
    mode_seconds = mode_clock_seconds(state, controller_type)
    per_page_wait = max(0, thresholds.per_page_seconds - current_page)
    next_boundary_wait = max(0, state.next_review_mode_seconds - mode_seconds)
    total_wait = max(0, thresholds.total_seconds - mode_seconds)
    single_page_wait = max(0, thresholds.single_page_seconds - current_page)
    trigger_wait = min(total_wait, single_page_wait)
    return max(per_page_wait, next_boundary_wait, trigger_wait)


def next_review_boundary(mode_seconds: int, total_seconds: int) -> int:
    """Return the strictly next total multiple after an acceptable defer."""
    return (mode_seconds // total_seconds + 1) * total_seconds

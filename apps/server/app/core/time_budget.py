from __future__ import annotations

from dataclasses import dataclass

from ..config import TimeBudgetConfig
from ..storage.sqlite import DriftClockStateRecord


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
    if not event_eligible or state.review_observation_id is not None:
        return False
    mode_seconds = mode_clock_seconds(state, controller_type)
    if state.current_page_drift_seconds < thresholds.per_page_seconds:
        return False
    if mode_seconds < state.next_review_mode_seconds:
        return False
    return (
        mode_seconds >= thresholds.total_seconds
        or state.current_page_drift_seconds >= thresholds.single_page_seconds
    )


def next_review_boundary(mode_seconds: int, total_seconds: int) -> int:
    """Return the strictly next total multiple after an acceptable defer."""
    return (mode_seconds // total_seconds + 1) * total_seconds

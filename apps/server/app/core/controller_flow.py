from __future__ import annotations

from datetime import datetime, timezone

from ..config import ControllerConfig
from ..schemas import Observation, PageInfo, PipelineAction, PipelineResult, Verdict
from ..storage.sqlite import ControllerStateRecord, SQLiteStore
from .controllers.alignment import AlignmentController
from .controllers.streak import StreakController


def apply_controller(
    store: SQLiteStore,
    config: ControllerConfig,
    observation: Observation,
    now: datetime | None = None,
) -> PipelineResult:
    if observation.verdict is None:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=observation.verdict,
            page=_page_info(observation),
        )

    state = store.get_controller_state(observation.session_id)
    controller = _controller_from_state(config, state)
    controller.update(observation.verdict, observation.features.r_final)
    now = now or datetime.now(timezone.utc)

    if controller.should_intervene(now):
        _save_controller_state(store, observation.session_id, controller, state, now)
        return PipelineResult(
            action=PipelineAction.REQUEST_EXCERPT,
            observation_id=observation.id,
            verdict=observation.verdict,
            page=_page_info(observation),
        )

    _save_controller_state(store, observation.session_id, controller, state, now)
    return PipelineResult(
        action=PipelineAction.NONE,
        observation_id=observation.id,
        verdict=observation.verdict,
        page=_page_info(observation),
    )


def confirm_controller_intervention(
    store: SQLiteStore,
    config: ControllerConfig,
    session_id: str,
    now: datetime | None = None,
) -> ControllerStateRecord:
    """Consume controller evidence only after Tier 2 confirms drift."""

    state = store.get_controller_state(session_id)
    controller = _controller_from_state(config, state)
    confirmed_at = now or datetime.now(timezone.utc)
    controller.on_intervened(confirmed_at)
    _save_controller_state(store, session_id, controller, state, confirmed_at)
    return store.get_controller_state(session_id)


def _controller_from_state(
    config: ControllerConfig,
    state: ControllerStateRecord,
) -> AlignmentController | StreakController:
    if config.type == "alignment":
        return AlignmentController(
            alpha=config.alignment_alpha,
            theta_low=config.theta_low,
            theta_high=config.theta_high,
            cooldown_seconds=config.cooldown_seconds,
            coldstart_observations=config.coldstart_observations,
            alignment_score=state.alignment_score,
            drift_latched=state.drift_latched,
            armed=state.streak,
            obs_count=state.obs_count,
            last_intervention_ts=state.last_intervention_ts,
            snoozed_until=state.snoozed_until,
        )
    return StreakController(
        k=config.k,
        cooldown_seconds=config.cooldown_seconds,
        coldstart_observations=config.coldstart_observations,
        streak=state.streak,
        obs_count=state.obs_count,
        last_intervention_ts=state.last_intervention_ts,
        snoozed_until=state.snoozed_until,
    )


def _page_info(observation: Observation) -> PageInfo:
    return PageInfo(
        host=observation.payload.get("url_host"),
        title=observation.payload.get("title"),
    )


def _save_controller_state(
    store: SQLiteStore,
    session_id: str,
    controller: AlignmentController | StreakController,
    previous_state: ControllerStateRecord,
    now: datetime,
) -> None:
    if isinstance(controller, AlignmentController):
        store.save_controller_state(
            session_id,
            streak=controller.armed,
            obs_count=controller.obs_count,
            last_intervention_ts=controller.last_intervention_ts,
            snoozed_until=controller.snoozed_until,
            alignment_score=controller.alignment_score,
            drift_latched=controller.drift_latched,
            ts=now,
        )
        return

    store.save_controller_state(
        session_id,
        streak=controller.streak,
        obs_count=controller.obs_count,
        last_intervention_ts=controller.last_intervention_ts,
        snoozed_until=controller.snoozed_until,
        alignment_score=previous_state.alignment_score,
        drift_latched=previous_state.drift_latched,
        ts=now,
    )

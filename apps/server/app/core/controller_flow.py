from __future__ import annotations

from datetime import datetime, timezone

from ..config import ControllerConfig
from ..schemas import Observation, PageInfo, PipelineAction, PipelineResult, Verdict
from ..storage.sqlite import SQLiteStore
from .controllers.streak import StreakController


def apply_controller(
    store: SQLiteStore,
    config: ControllerConfig,
    observation: Observation,
) -> PipelineResult:
    if observation.verdict is None:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=observation.verdict,
            page=_page_info(observation),
        )

    state = store.get_controller_state(observation.session_id)
    controller = StreakController(
        k=config.k,
        cooldown_seconds=config.cooldown_seconds,
        coldstart_observations=config.coldstart_observations,
        streak=state.streak,
        obs_count=state.obs_count,
        last_intervention_ts=state.last_intervention_ts,
        snoozed_until=state.snoozed_until,
    )
    controller.update(observation.verdict, observation.features.r_final)
    now = datetime.now(timezone.utc)

    if controller.should_intervene(now):
        controller.on_intervened(now)
        store.save_controller_state(
            observation.session_id,
            streak=controller.streak,
            obs_count=controller.obs_count,
            last_intervention_ts=controller.last_intervention_ts,
            snoozed_until=controller.snoozed_until,
            ts=now,
        )
        store.record_intervention_requested(observation.session_id, observation.id, now)
        return PipelineResult(
            action=PipelineAction.REQUEST_EXCERPT,
            observation_id=observation.id,
            verdict=observation.verdict,
            page=_page_info(observation),
        )

    store.save_controller_state(
        observation.session_id,
        streak=controller.streak,
        obs_count=controller.obs_count,
        last_intervention_ts=controller.last_intervention_ts,
        snoozed_until=controller.snoozed_until,
        ts=now,
    )
    return PipelineResult(
        action=PipelineAction.NONE,
        observation_id=observation.id,
        verdict=observation.verdict,
        page=_page_info(observation),
    )


def _page_info(observation: Observation) -> PageInfo:
    return PageInfo(
        host=observation.payload.get("url_host"),
        title=observation.payload.get("title"),
    )

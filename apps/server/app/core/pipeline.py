from datetime import datetime, timezone

from ..schemas import Observation, PipelineAction, PipelineResult, Verdict
from .controllers.base import Controller


async def handle_judged_observation(
    obs: Observation,
    verdict: Verdict,
    controller: Controller,
) -> PipelineResult:
    controller.update(verdict, obs.features.r_final)
    if controller.should_intervene(datetime.now(timezone.utc)):
        return PipelineResult(
            action=PipelineAction.REQUEST_EXCERPT,
            observation_id=obs.id,
            verdict=verdict,
        )
    return PipelineResult(action=PipelineAction.NONE, observation_id=obs.id, verdict=verdict)

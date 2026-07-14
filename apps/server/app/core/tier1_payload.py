from __future__ import annotations

from ..config import Tier1Config
from ..schemas import Goal, Observation
from ..storage.sqlite import ObservationSummary


def build_tier1_payload(
    goal: Goal,
    observation: Observation,
    recent: list[ObservationSummary],
    config: Tier1Config,
) -> dict[str, object]:
    current: dict[str, object] = {}
    if config.send.title:
        current["title"] = observation.payload.get("title") or ""
    if config.send.url_host:
        current["url_host"] = observation.payload.get("url_host") or ""

    payload: dict[str, object] = {
        "goal": goal.raw_text,
        "current": current,
    }
    derived_phrases = getattr(goal, "derived_phrases", [])
    if derived_phrases:
        payload["goal.derived_phrases"] = list(derived_phrases)
    if config.send.recent_titles:
        payload["recent"] = [
            {"title": item.title or "", "verdict": item.verdict or ""}
            for item in recent
            if item.title or item.verdict
        ]
    return payload

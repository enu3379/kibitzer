from __future__ import annotations

from ..config import Tier2Config
from ..schemas import PageExcerpt
from ..storage.sqlite import GoalRecord, ObservationContentSummary, ObservationRecord, ObservationSummary


def build_tier2_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    recent: list[ObservationSummary],
    excerpt: PageExcerpt,
    config: Tier2Config,
) -> dict[str, object]:
    return {
        "goal": goal.raw_text,
        "current": {
            "title": observation.title,
            "url_host": observation.url_host,
            "verdict": observation.verdict,
            "tier_reached": observation.tier_reached,
            "tier0_score": observation.features.get("r0"),
        },
        "recent": [
            {"title": item.title, "verdict": item.verdict}
            for item in recent
            if item.title or item.verdict
        ],
        "page_excerpt": _clean_excerpt(excerpt.text, config.excerpt_char_limit),
    }


def build_d7_title_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    recent: list[ObservationSummary],
    time_context: dict[str, object],
) -> dict[str, object]:
    return {
        "review_kind": "title",
        "goal": goal.raw_text,
        "time_budget": time_context,
        "current": {"title": observation.title, "url_host": observation.url_host},
        "recent": [
            {"title": item.title, "verdict": item.verdict}
            for item in recent
            if item.title or item.verdict
        ],
    }


def build_d7_content_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    current_excerpt: str,
    recent: list[ObservationContentSummary],
    time_context: dict[str, object],
) -> dict[str, object]:
    return {
        "review_kind": "content",
        "goal": goal.raw_text,
        "time_budget": time_context,
        "current": {
            "title": observation.title,
            "url_host": observation.url_host,
            "page_excerpt": current_excerpt,
        },
        "recent": [
            {"title": item.title, "verdict": item.verdict, "page_excerpt": item.text}
            for item in recent
            if item.text
        ],
    }


def fallback_drift_message(goal: GoalRecord, observation: ObservationRecord) -> str:
    title = observation.title or observation.url_host or "현재 페이지"
    return f"'{title}' 흐름이 '{goal.raw_text}' 목표에서 벗어난 것 같습니다. 계속 필요한 곁가지인지 확인해볼까요?"


def _clean_excerpt(text: str, limit: int) -> str:
    normalized = " ".join(text.split())
    return normalized[:limit]

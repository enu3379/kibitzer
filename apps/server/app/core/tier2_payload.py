from __future__ import annotations

from ..config import Tier2Config
from ..providers.judges.base import Tier2Decision
from ..schemas import PageExcerpt
from ..storage.sqlite import GoalRecord, ObservationContentSummary, ObservationRecord, ObservationSummary


def build_tier2_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    recent: list[ObservationSummary],
    excerpt: PageExcerpt,
    config: Tier2Config,
) -> dict[str, object]:
    return build_tier2_review_payload(
        goal,
        observation,
        recent,
        excerpt.text,
        [],
        None,
        config,
    )


def build_tier2_review_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    recent_titles: list[ObservationSummary],
    current_excerpt: str | None,
    recent_content: list[ObservationContentSummary],
    time_context: dict[str, object] | None,
    config: Tier2Config,
) -> dict[str, object]:
    cleaned_excerpt = _clean_excerpt(current_excerpt or "", config.excerpt_char_limit)
    payload: dict[str, object] = {
        "review_kind": "combined",
        "goal": goal.raw_text,
        "current": {
            "title": observation.title,
            "url_host": observation.url_host,
            "verdict": observation.verdict,
            "tier_reached": observation.tier_reached,
            "tier0_score": observation.features.get("r0"),
            "page_excerpt": cleaned_excerpt or None,
        },
        "recent_titles": compress_recent_titles(recent_titles),
        "recent_pages": [
            {
                "title": item.title,
                "verdict": item.verdict,
                "page_excerpt": item.text,
            }
            for item in recent_content
            if item.text
        ],
        "repeat_signals": {
            "current_title_recent_visits": sum(
                1
                for item in recent_titles
                if observation.title and item.title == observation.title
            ),
        },
    }
    if time_context is not None:
        payload["time_budget"] = time_context
    return payload


def build_tier2_message_payload(
    goal: GoalRecord,
    observation: ObservationRecord,
    decision: Tier2Decision,
    time_context: dict[str, object] | None,
    nagging_context: dict[str, object],
) -> dict[str, object]:
    payload: dict[str, object] = {
        "goal": goal.raw_text,
        "current": {
            "title": observation.title,
            "url_host": observation.url_host,
        },
        "judgment": {
            "decision": decision.decision,
            "reason_code": decision.reason_code,
            "basis": decision.basis,
        },
        "nagging_context": nagging_context,
    }
    if time_context is not None:
        payload["time_budget"] = time_context
    return payload


def compress_recent_titles(recent: list[ObservationSummary]) -> list[dict[str, object]]:
    compressed: list[dict[str, object]] = []
    for item in recent:
        if not item.title and not item.verdict:
            continue
        if (
            compressed
            and compressed[-1]["title"] == item.title
            and compressed[-1]["verdict"] == item.verdict
        ):
            compressed[-1]["repeat_count"] = int(compressed[-1]["repeat_count"]) + 1
            continue
        compressed.append(
            {
                "title": item.title,
                "verdict": item.verdict,
                "repeat_count": 1,
            }
        )
    return compressed


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

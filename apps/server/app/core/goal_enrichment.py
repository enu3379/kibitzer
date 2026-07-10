from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

from ..config import GoalEnrichmentConfig
from ..providers.embeddings.base import EmbeddingProvider
from ..storage.sqlite import SQLiteStore
from .relevance import cosine


GOAL_ENRICHMENT_PROMPT = """You expand a user's declared browsing goal into short search-style phrases.
The phrases seed a local lexical matcher that decides whether a browser tab
title is related to the goal, so each phrase must read like something that
would literally appear in the title of a related page.

Declared goal (verbatim): "{goal_text}"

Return strict JSON only: {{"phrases": ["...", "..."]}}

Rules:
- At most {max_phrases} phrases.
- Each phrase 2-6 words, content-bearing, specific to this goal's subject.
- Cover DISTINCT aspects (actions, tools, entities, synonyms, adjacent
  sub-tasks) — not rewordings of one phrase.
- If pages about this topic are commonly in another language (software,
  gaming, tech, research → English), write roughly half the phrases in that
  language.
- NEVER output: bare platform/site names (YouTube, Google, 나무위키, Reddit),
  bare generic activity words (검색, 리뷰, 정리, 공략, tutorial, guide —
  allowed only when tightly bound to a goal-specific noun), or single common
  words.
- Test each phrase: if this phrase alone appeared in a page title, would that
  page almost certainly be about the goal? If not, drop it.

Example — goal "국내 여행지 탐색":
{{"phrases": ["국내 여행지 추천 코스", "제주 부산 강릉 여행", "국내 숙소 예약
비교", "당일치기 근교 여행", "domestic Korea travel itinerary"]}}
"""


@dataclass(frozen=True)
class DerivedPhrase:
    phrase: str
    vector: list[float]


class GoalEnrichmentProvider(Protocol):
    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        ...


def build_goal_enrichment_prompt(goal_text: str, max_phrases: int) -> str:
    return GOAL_ENRICHMENT_PROMPT.format(goal_text=goal_text, max_phrases=max_phrases)


def parse_goal_enrichment_response(content: str, max_phrases: int) -> list[str]:
    # Live cloud models wrap the JSON in thinking preambles or code fences;
    # mirror the judges' lenient extraction (_load_json_object) so enrichment
    # survives the same responses Tier 1 already survives.
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start == -1 or end <= start:
            raise
        data = json.loads(content[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("goal enrichment response must be a JSON object")
    phrases = data.get("phrases")
    if not isinstance(phrases, list):
        raise ValueError("goal enrichment response must include phrases")
    parsed: list[str] = []
    for item in phrases[:max_phrases]:
        if isinstance(item, str):
            parsed.append(item)
    return parsed


async def request_goal_phrases(
    provider: GoalEnrichmentProvider,
    goal_text: str,
    config: GoalEnrichmentConfig,
) -> list[str]:
    prompt = build_goal_enrichment_prompt(goal_text, config.max_phrases)
    last_parse_error: Exception | None = None
    for _attempt in range(2):
        content = await provider.complete_goal_enrichment(prompt, config.timeout_seconds)
        try:
            return parse_goal_enrichment_response(content, config.max_phrases)
        except (json.JSONDecodeError, ValueError) as exc:
            last_parse_error = exc
    assert last_parse_error is not None
    raise last_parse_error


async def filter_derived_phrases(
    phrases: list[str],
    *,
    goal_text: str,
    embedding_provider: EmbeddingProvider,
    max_phrases: int,
) -> list[DerivedPhrase]:
    normalized_goal = " ".join(goal_text.strip().split()).casefold()
    candidates: list[str] = []
    seen: set[str] = set()
    for phrase in phrases[:max_phrases]:
        normalized = " ".join(str(phrase).strip().split())
        if not normalized:
            continue
        token_count = len(normalized.split())
        if token_count < 2 or token_count > 8:
            continue
        key = normalized.casefold()
        if key == normalized_goal or key in seen:
            continue
        seen.add(key)
        candidates.append(normalized)

    if not candidates:
        return []

    vectors = await embedding_provider.embed(candidates)
    kept: list[DerivedPhrase] = []
    for phrase, vector in zip(candidates, vectors, strict=True):
        if any(cosine(vector, existing.vector) > 0.95 for existing in kept):
            continue
        kept.append(DerivedPhrase(phrase=phrase, vector=vector))
    return kept


async def enrich_goal_derived_exemplars(
    *,
    session_id: str,
    goal_text: str,
    provider: Any,
    embedding_provider: EmbeddingProvider,
    store: SQLiteStore,
    config: GoalEnrichmentConfig,
) -> None:
    if not config.enabled:
        return

    complete = getattr(provider, "complete_goal_enrichment", None)
    if provider is None or not callable(complete):
        store.record_goal_enrichment_failed(session_id, "provider_unavailable")
        return

    started = time.perf_counter()
    provider_name = _provider_name(provider)
    try:
        raw_phrases = await request_goal_phrases(provider, goal_text, config)
        derived = await filter_derived_phrases(
            raw_phrases,
            goal_text=goal_text,
            embedding_provider=embedding_provider,
            max_phrases=config.max_phrases,
        )
        current = store.get_current_session()
        if not current or current.session.id != session_id or not current.goal or current.goal.raw_text != goal_text:
            return
        latency_ms = int((time.perf_counter() - started) * 1000)
        store.replace_goal_derived_exemplars(
            session_id=session_id,
            exemplars=derived,
            provider=provider_name,
            latency_ms=latency_ms,
        )
    except Exception as exc:
        store.record_goal_enrichment_failed(session_id, type(exc).__name__)


def _provider_name(provider: Any) -> str:
    name = type(provider).__name__
    if name.endswith("JudgeProvider"):
        name = name[: -len("JudgeProvider")]
    return name or "unknown"

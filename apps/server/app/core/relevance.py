from __future__ import annotations

import math
from dataclasses import dataclass

from ..schemas import Verdict


# A successful related judgment uses the same relevance value whether it comes
# from Tier 1 or an explicit page-label correction.
RELATED_RELEVANCE = 0.85

# An explicit user correction to drift uses the same replacement relevance as
# PR #36's Tier 1 DRIFT override while keeping the detector's raw r immutable.
DRIFT_RELEVANCE = 0.0

# Tier 1 overrides the raw embedding score after it reviews a Tier 0 drift.
# DRIFT stays below the default alignment theta_low; mapping it to 0.15 would
# only approach that strict boundary from above and never arm the controller.
TIER1_DRIFT_RELEVANCE = DRIFT_RELEVANCE


@dataclass(frozen=True)
class Tier0Score:
    score: float
    exemplar_score: float
    anchor_score: float
    derived_score: float = 0.0


def anchor_admission_eligible(
    score: Tier0Score,
    *,
    has_derived_exemplars: bool,
    anchor_epsilon: float,
    derived_tau: float,
    verdict: Verdict | None,
    tier_reached: int | None,
    tier1_anchor_floor: float = 0.0,
) -> bool:
    # A Tier 1 OK alone is not enough to steer the anchor: one false OK on a
    # self-similar page cluster (e.g. a webtoon binge) seeds a self-reinforcing
    # anchor loop. Tier 1 OKs get their own affinity gate and must not fall
    # through to the epsilon branch — epsilon (0.05) is low enough that even
    # unrelated Korean titles clear it, which would void the Tier 1 floor.
    if verdict == Verdict.OK and (tier_reached or 0) >= 1:
        return _goal_affinity(score, derived_tau) >= tier1_anchor_floor
    return (
        score.exemplar_score >= anchor_epsilon
        or (has_derived_exemplars and score.derived_score >= derived_tau)
    )


def _goal_affinity(score: Tier0Score, derived_tau: float) -> float:
    """Similarity to the goal itself (exemplars or derived phrases), anchor excluded."""
    derived = score.derived_score if score.derived_score >= derived_tau else 0.0
    return max(score.exemplar_score, derived)


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def tier0_score_parts(
    emb: list[float],
    exemplars: list[list[float]],
    anchor: list[float] | None,
    beta: float,
    derived_exemplars: list[list[float]] | None = None,
    derived_tau: float = 0.0,
    anchor_tiebreak_floor: float = 0.0,
) -> Tier0Score:
    exemplar_score = max((cosine(emb, ex) for ex in exemplars), default=0.0)
    anchor_score = beta * cosine(emb, anchor) if anchor else 0.0
    derived_score = max((cosine(emb, ex) for ex in (derived_exemplars or [])), default=0.0)
    derived_contribution = derived_score if derived_score >= derived_tau else 0.0
    # The anchor is a tiebreaker, not a standalone judge: it may only lift pages
    # that already show direct goal affinity. Without this floor, a polluted
    # anchor can solo-OK pages the goal knows nothing about.
    affinity = max(exemplar_score, derived_contribution)
    anchor_contribution = anchor_score if affinity >= anchor_tiebreak_floor else 0.0
    return Tier0Score(
        score=max(exemplar_score, anchor_contribution, derived_contribution),
        exemplar_score=exemplar_score,
        anchor_score=anchor_score,
        derived_score=derived_score,
    )


def tier0_score(
    emb: list[float],
    exemplars: list[list[float]],
    anchor: list[float] | None,
    beta: float,
    derived_exemplars: list[list[float]] | None = None,
    derived_tau: float = 0.0,
    anchor_tiebreak_floor: float = 0.0,
) -> float:
    return tier0_score_parts(
        emb, exemplars, anchor, beta, derived_exemplars, derived_tau, anchor_tiebreak_floor
    ).score


def tier1_final_relevance(verdict: Verdict) -> float:
    """Map a successful Tier 1 verdict onto the controller relevance scale."""
    if verdict == Verdict.OK:
        return RELATED_RELEVANCE
    return TIER1_DRIFT_RELEVANCE

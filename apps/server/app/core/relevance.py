from __future__ import annotations

import math
from dataclasses import dataclass

from ..schemas import Verdict


# A successful related judgment uses the same relevance value whether it comes
# from Tier 1 or an explicit page-label correction.
RELATED_RELEVANCE = 0.85

# Tier 1 overrides the raw embedding score after it reviews a Tier 0 drift.
# DRIFT stays below the default alignment theta_low; mapping it to 0.15 would
# only approach that strict boundary from above and never arm the controller.
TIER1_DRIFT_RELEVANCE = 0.0


@dataclass(frozen=True)
class Tier0Score:
    score: float
    exemplar_score: float
    anchor_score: float
    derived_score: float = 0.0


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
) -> Tier0Score:
    exemplar_score = max((cosine(emb, ex) for ex in exemplars), default=0.0)
    anchor_score = beta * cosine(emb, anchor) if anchor else 0.0
    derived_score = max((cosine(emb, ex) for ex in (derived_exemplars or [])), default=0.0)
    derived_contribution = derived_score if derived_score >= derived_tau else 0.0
    return Tier0Score(
        score=max(exemplar_score, anchor_score, derived_contribution),
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
) -> float:
    return tier0_score_parts(emb, exemplars, anchor, beta, derived_exemplars, derived_tau).score


def tier0_verdict(score: float, tau_ok: float) -> str:
    return "OK" if score >= tau_ok else "DRIFT"


def tier1_final_relevance(verdict: Verdict) -> float:
    """Map a successful Tier 1 verdict onto the controller relevance scale."""
    if verdict == Verdict.OK:
        return RELATED_RELEVANCE
    return TIER1_DRIFT_RELEVANCE

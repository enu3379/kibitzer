from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Tier0Score:
    score: float
    exemplar_score: float
    anchor_score: float


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
) -> Tier0Score:
    exemplar_score = max((cosine(emb, ex) for ex in exemplars), default=0.0)
    anchor_score = beta * cosine(emb, anchor) if anchor else 0.0
    return Tier0Score(
        score=max(exemplar_score, anchor_score),
        exemplar_score=exemplar_score,
        anchor_score=anchor_score,
    )


def tier0_score(
    emb: list[float],
    exemplars: list[list[float]],
    anchor: list[float] | None,
    beta: float,
) -> float:
    return tier0_score_parts(emb, exemplars, anchor, beta).score


def tier0_verdict(score: float, tau_ok: float) -> str:
    return "OK" if score >= tau_ok else "DRIFT"

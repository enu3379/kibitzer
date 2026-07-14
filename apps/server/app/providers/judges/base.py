from dataclasses import dataclass
from typing import Iterator, Protocol

from ...schemas import Verdict


@dataclass(frozen=True)
class Tier1Result:
    verdict: Verdict
    reason: str


@dataclass(frozen=True)
class Tier2Result:
    confirm_drift: bool
    message: str | None


class JudgeProvider(Protocol):
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        ...

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        ...

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        ...


def ordered_api_keys(
    pool: tuple[str, ...] | None,
    primary: str,
    fallback: str | None,
    rotation: "Iterator[int]",
) -> list[str]:
    """Keys to try for one call, in order.

    With a multi-key pool the starting key rotates per call so usage spreads
    evenly across keys, and the remaining pool keys stay in line as fallbacks.
    Without a pool the order is fixed: primary, then the optional fallback.
    """
    keys = [key for key in (pool or ()) if key]
    if len(keys) > 1:
        start = next(rotation) % len(keys)
        return keys[start:] + keys[:start]
    if keys:
        return keys
    return [primary] + ([fallback] if fallback else [])

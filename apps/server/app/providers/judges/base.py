from dataclasses import dataclass
from typing import Protocol

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

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        ...

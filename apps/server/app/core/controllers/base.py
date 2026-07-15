from datetime import datetime
from typing import Protocol

from ...schemas import Verdict


class Controller(Protocol):
    def update(self, verdict: Verdict, r: float | None = None) -> None:
        ...

    def should_intervene(self, now: datetime) -> bool:
        ...

    def on_intervened(self, now: datetime) -> None:
        ...


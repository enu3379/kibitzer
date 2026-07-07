from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ...schemas import Verdict


@dataclass
class WindowController:
    k: int = 3
    window_size: int = 5
    cooldown_seconds: int = 300
    coldstart_observations: int = 5
    recent_verdicts: tuple[str | Verdict | None, ...] = field(default_factory=tuple)
    streak: int = 0
    obs_count: int = 0
    last_intervention_ts: datetime | None = None
    snoozed_until: datetime | None = None

    def update(self, verdict: Verdict, r: float | None = None) -> None:
        self.obs_count += 1
        if self.recent_verdicts:
            window = self.recent_verdicts[-max(1, self.window_size) :]
            self.streak = sum(1 for item in window if item == Verdict.DRIFT or item == Verdict.DRIFT.value)
            return
        if verdict == Verdict.DRIFT:
            self.streak = min(max(1, self.window_size), self.streak + 1)

    def should_intervene(self, now: datetime) -> bool:
        if self.obs_count < self.coldstart_observations:
            return False
        if self.streak < self.k:
            return False
        if self.snoozed_until and now < self.snoozed_until:
            return False
        if self.last_intervention_ts:
            cooldown_until = self.last_intervention_ts + timedelta(seconds=self.cooldown_seconds)
            if now < cooldown_until:
                return False
        return True

    def on_intervened(self, now: datetime) -> None:
        self.streak = 0
        self.last_intervention_ts = now

    def on_feedback(self, kind: str) -> None:
        if kind == "relevant":
            self.streak = 0

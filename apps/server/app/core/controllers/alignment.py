from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass
class AlignmentController:
    alpha: float = 0.85
    theta_low: float = 0.15
    theta_high: float = 0.3
    cooldown_seconds: int = 300
    coldstart_observations: int = 5
    alignment_score: float | None = None
    drift_latched: bool = False
    armed: int = 0
    obs_count: int = 0
    last_intervention_ts: datetime | None = None
    snoozed_until: datetime | None = None

    def update(self, verdict, r: float | None = None) -> None:
        self.obs_count += 1
        if r is None:
            r = 1.0 if str(verdict).endswith("OK") else 0.0

        alpha = min(0.99, max(0.0, self.alpha))
        previous = float(r) if self.alignment_score is None else self.alignment_score
        self.alignment_score = alpha * previous + (1.0 - alpha) * float(r)

        self._refresh_drift_state()

    def _refresh_drift_state(self) -> None:
        if self.alignment_score is None:
            return

        if self.alignment_score > self.theta_high:
            self.drift_latched = False
            self.armed = 0
            return

        if self.alignment_score < self.theta_low:
            if not self.drift_latched:
                self.armed = 1
            self.drift_latched = True

    def should_intervene(self, now: datetime) -> bool:
        if self.obs_count < self.coldstart_observations:
            return False
        if self.armed < 1:
            return False
        if self.snoozed_until and now < self.snoozed_until:
            return False
        if self.last_intervention_ts:
            cooldown_until = self.last_intervention_ts + timedelta(seconds=self.cooldown_seconds)
            if now < cooldown_until:
                return False
        return True

    def on_intervened(self, now: datetime) -> None:
        self.armed = 0
        self.last_intervention_ts = now

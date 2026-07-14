import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config, Tier2Config, TimeBudgetConfig
from apps.server.app.core.time_budget import next_review_boundary, review_is_due, thresholds_for_budget
from apps.server.app.main import create_app
from apps.server.app.providers.judges.base import Tier1Result, Tier2Result
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import DriftClockStateRecord, SQLiteStore


class FakeTier2Provider:
    def __init__(self, result: Tier2Result) -> None:
        self.result = result
        self.payloads: list[dict[str, object]] = []

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        self.payloads.append(payload)
        return self.result


def clock_state(**changes: object) -> DriftClockStateRecord:
    now = datetime(2026, 7, 14, tzinfo=timezone.utc)
    values: dict[str, object] = {
        "session_id": "session",
        "active_observation_id": "obs",
        "active_tab_id": 1,
        "active_url_path_hash": "hash",
        "active_verdict": "DRIFT",
        "active_since_at": now,
        "last_heartbeat_at": now,
        "current_page_drift_seconds": 0,
        "continuous_drift_seconds": 0,
        "cumulative_drift_seconds": 0,
        "next_review_mode_seconds": 0,
        "review_observation_id": None,
        "review_status": "none",
        "last_defer_reason": None,
        "updated_at": now,
    }
    values.update(changes)
    return DriftClockStateRecord(**values)  # type: ignore[arg-type]


class TimeBudgetPolicyTest(unittest.TestCase):
    def test_thresholds_use_budget_floor_and_fallback(self) -> None:
        config = TimeBudgetConfig(enabled=True)
        self.assertEqual(thresholds_for_budget(config, None).total_seconds, 900)
        self.assertEqual(thresholds_for_budget(config, 10).total_seconds, 300)
        self.assertEqual(thresholds_for_budget(config, 120).total_seconds, 1200)

    def test_per_page_valve_and_defer_boundary(self) -> None:
        config = TimeBudgetConfig(enabled=True, fallback_total_seconds=1200, per_page_seconds=180)
        thresholds = thresholds_for_budget(config, None)
        state = clock_state(current_page_drift_seconds=600, continuous_drift_seconds=600)
        self.assertTrue(review_is_due(state, "streak", thresholds, event_eligible=True))
        deferred = clock_state(
            current_page_drift_seconds=600,
            continuous_drift_seconds=600,
            next_review_mode_seconds=next_review_boundary(600, thresholds.total_seconds),
        )
        self.assertFalse(review_is_due(deferred, "streak", thresholds, event_eligible=True))
        self.assertEqual(deferred.next_review_mode_seconds, 1200)


class D7ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        self.provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="시간 예산과 무관한 페이지입니다."))
        self.config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=True, excerpt_char_limit=120),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
            time_budget=TimeBudgetConfig(
                enabled=True,
                fallback_total_seconds=180,
                min_total_seconds=60,
                per_page_seconds=60,
                heartbeat_seconds=60,
                max_heartbeat_gap_seconds=90,
                recent_excerpts=2,
                recent_excerpt_char_limit=40,
            ),
        )
        self.client = TestClient(create_app(config=self.config, store=self.store, tier2_provider=self.provider))
        self.client.__enter__()
        self.start = datetime(2026, 7, 14, 8, 0, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _start_drift_observation(self) -> tuple[str, str]:
        self.client.post("/sessions")
        goal = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API", "available_time_minutes": 18},
        )
        self.assertEqual(goal.status_code, 200)
        self.assertEqual(goal.json()["available_time_minutes"], 18)
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "ts": self.start.isoformat(),
                "payload": {
                    "url": "https://example.com/bread",
                    "title": "Sourdough bread recipe",
                    "tab_id": 7,
                },
            },
        ).json()
        self.assertEqual(response["action"], "none")
        observation_id = str(response["observation_id"])
        path_hash = self.store.get_observation(observation_id).url_path_hash
        assert path_hash
        return observation_id, path_hash

    def _presence(self, observation_id: str, path_hash: str, event_id: str, kind: str, at: datetime) -> dict[str, object]:
        with patch("apps.server.app.api.observations.datetime") as mocked_datetime:
            mocked_datetime.now.return_value = at
            response = self.client.post(
                f"/observations/{observation_id}/presence",
                json={
                    "event_id": event_id,
                    "kind": kind,
                    "tab_id": 7,
                    "url_path_hash": path_hash,
                },
            )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_budget_is_returned_and_dual_review_notifies_only_after_dwell(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        content = self.client.post(
            f"/observations/{observation_id}/content",
            json={"title": "Bread", "text": "A long recipe unrelated to Kibitzer."},
        )
        self.assertEqual(content.status_code, 200)
        self.assertTrue(content.json()["stored"])

        first = self._presence(observation_id, path_hash, "active", "active", self.start)
        second = self._presence(observation_id, path_hash, "one-minute", "heartbeat", self.start + timedelta(seconds=60))
        third = self._presence(observation_id, path_hash, "two-minutes", "heartbeat", self.start + timedelta(seconds=120))

        self.assertEqual(first["action"], "none")
        self.assertEqual(second["action"], "none")
        self.assertEqual(third["action"], "notify")
        self.assertEqual(len(self.provider.payloads), 2)
        self.assertEqual({payload["review_kind"] for payload in self.provider.payloads}, {"title", "content"})
        state = self.store.get_drift_clock_state(self.client.get("/sessions/current/state").json()["session_id"])
        self.assertEqual(state.current_page_drift_seconds, 120)

    def test_duplicate_presence_does_not_double_count(self) -> None:
        observation_id, path_hash = self._start_drift_observation()
        self._presence(observation_id, path_hash, "active", "active", self.start)
        self._presence(observation_id, path_hash, "same", "heartbeat", self.start + timedelta(seconds=60))
        self._presence(observation_id, path_hash, "same", "heartbeat", self.start + timedelta(seconds=90))
        session_id = self.client.get("/sessions/current/state").json()["session_id"]
        state = self.store.get_drift_clock_state(session_id)
        self.assertEqual(state.current_page_drift_seconds, 60)


if __name__ == "__main__":
    unittest.main()

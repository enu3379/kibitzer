import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.main import create_app
from apps.server.app.schemas import Observation, ObservationFeatures, Source, Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class SessionLifecycleApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        snooze_seconds: int = 900,
        coldstart_observations: int = 5,
        controller_type: str = "streak",
        k: int = 3,
        window_size: int = 5,
    ) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(
                type=controller_type,
                k=k,
                window_size=window_size,
                coldstart_observations=coldstart_observations,
                cooldown_seconds=300,
                snooze_seconds=snooze_seconds,
            ),
        )
        client = TestClient(create_app(config=config, store=self.store))
        client.__enter__()
        return client

    def _seed_observation(
        self,
        session_id: str,
        verdict: Verdict | None,
        url_host: str = "example.com",
        title: str = "Example page",
    ) -> str:
        observation = Observation(
            id=f"obs_{uuid.uuid4().hex}",
            ts=datetime.now(timezone.utc),
            session_id=session_id,
            source=Source.BROWSER_NAV,
            payload={"url_host": url_host, "title": title},
            features=ObservationFeatures(emb=[0.5], tier_reached=0),
            verdict=verdict,
        )
        self.store.record_observation(observation)
        return observation.id

    def test_state_requires_active_session(self) -> None:
        client = self._client()
        self.assertEqual(client.get("/sessions/current/state").status_code, 404)
        self.assertEqual(client.get("/sessions/current/stats").status_code, 404)
        self.assertEqual(client.post("/sessions/current/snooze").status_code, 404)
        self.assertEqual(client.post("/sessions/current/end").status_code, 404)

    def test_state_reports_goal_and_coldstart(self) -> None:
        client = self._client()
        session_id = client.post("/sessions").json()["id"]

        state = client.get("/sessions/current/state").json()
        self.assertEqual(state["session_id"], session_id)
        self.assertFalse(state["has_goal"])
        self.assertEqual(state["tracking"], "coldstart")
        self.assertEqual(state["controller_type"], "streak")
        self.assertEqual(state["streak"], 0)
        self.assertEqual(state["streak_threshold"], 3)
        self.assertEqual(state["window_size"], 5)
        self.assertEqual(state["obs_count"], 0)
        self.assertIsNone(state["snoozed_until"])
        self.assertIsNone(state["cooldown_until"])

        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})
        state = client.get("/sessions/current/state").json()
        self.assertTrue(state["has_goal"])

    def test_state_reports_window_controller_score(self) -> None:
        client = self._client(controller_type="window", k=3, window_size=5)
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})

        for verdict in [Verdict.DRIFT, Verdict.OK, Verdict.DRIFT, Verdict.OK, Verdict.DRIFT]:
            self._seed_observation(session_id, verdict)

        state = client.get("/sessions/current/state").json()
        self.assertEqual(state["controller_type"], "window")
        self.assertEqual(state["streak"], 3)
        self.assertEqual(state["streak_threshold"], 3)
        self.assertEqual(state["window_size"], 5)

    def test_snooze_sets_state_and_zero_duration_clears_it(self) -> None:
        client = self._client(snooze_seconds=900)
        client.post("/sessions").json()

        before = datetime.now(timezone.utc)
        snooze = client.post("/sessions/current/snooze").json()
        snoozed_until = datetime.fromisoformat(snooze["snoozed_until"])
        delta = (snoozed_until - before).total_seconds()
        self.assertGreater(delta, 890)
        self.assertLess(delta, 910)

        state = client.get("/sessions/current/state").json()
        self.assertEqual(state["tracking"], "snoozed")
        self.assertIsNotNone(state["snoozed_until"])

        client.post("/sessions/current/snooze", json={"duration_seconds": 0})
        state = client.get("/sessions/current/state").json()
        self.assertNotEqual(state["tracking"], "snoozed")
        self.assertIsNone(state["snoozed_until"])

    def test_snooze_honors_custom_duration(self) -> None:
        client = self._client(snooze_seconds=900)
        client.post("/sessions").json()

        before = datetime.now(timezone.utc)
        snooze = client.post("/sessions/current/snooze", json={"duration_seconds": 1800}).json()
        snoozed_until = datetime.fromisoformat(snooze["snoozed_until"])
        delta = (snoozed_until - before).total_seconds()
        self.assertGreater(delta, 1790)
        self.assertLess(delta, 1810)

    def test_stats_aggregates_observations_and_interventions(self) -> None:
        client = self._client()
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})

        for _ in range(3):
            self._seed_observation(session_id, Verdict.OK, url_host="visitfinland.com")
        drift_id = self._seed_observation(session_id, Verdict.DRIFT, url_host="youtube.com")
        self._seed_observation(session_id, Verdict.DRIFT, url_host="youtube.com")
        self._seed_observation(session_id, None, url_host="example.com")

        intervention_id = self.store.create_intervention(session_id, drift_id, "Drift detected.")
        self.store.update_intervention_status(intervention_id, "accepted")

        stats = client.get("/sessions/current/stats").json()
        self.assertEqual(stats["session_id"], session_id)
        self.assertEqual(stats["observations"], 6)
        self.assertEqual(stats["ok"], 3)
        self.assertEqual(stats["drift"], 2)
        self.assertEqual(stats["unjudged"], 1)
        self.assertAlmostEqual(stats["related_ratio"], 0.6)
        self.assertEqual(stats["interventions"], 1)
        self.assertEqual(stats["interventions_accepted"], 1)
        self.assertEqual(stats["top_drift_host"], "youtube.com")
        self.assertEqual(stats["top_drift_count"], 2)
        self.assertIsNone(stats["ended_at"])
        self.assertGreaterEqual(stats["duration_seconds"], 0)

    def test_stats_with_no_judged_observations(self) -> None:
        client = self._client()
        client.post("/sessions").json()

        stats = client.get("/sessions/current/stats").json()
        self.assertEqual(stats["observations"], 0)
        self.assertIsNone(stats["related_ratio"])
        self.assertIsNone(stats["top_drift_host"])
        self.assertEqual(stats["top_drift_count"], 0)

    def test_state_exposes_pending_intervention_until_feedback(self) -> None:
        client = self._client()
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})
        self.assertIsNone(client.get("/sessions/current/state").json()["pending_intervention"])

        observation_id = self._seed_observation(session_id, Verdict.DRIFT, url_host="youtube.com")
        intervention_id = self.store.create_intervention(session_id, observation_id, "Drift detected.")
        client.post(f"/interventions/{intervention_id}/delivery", json={"ok": True})

        pending = client.get("/sessions/current/state").json()["pending_intervention"]
        self.assertEqual(pending["intervention_id"], intervention_id)
        self.assertEqual(pending["message"], "Drift detected.")
        self.assertEqual(pending["status"], "delivered")

        client.post(
            "/feedback",
            json={"kind": "accepted", "intervention_id": intervention_id, "observation_id": observation_id},
        )
        self.assertIsNone(client.get("/sessions/current/state").json()["pending_intervention"])

    def test_delivery_report_updates_intervention_status(self) -> None:
        client = self._client()
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})
        observation_id = self._seed_observation(session_id, Verdict.DRIFT, url_host="youtube.com")
        intervention_id = self.store.create_intervention(session_id, observation_id, "Drift detected.")

        response = client.post(f"/interventions/{intervention_id}/delivery", json={"ok": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "delivered")
        self.assertEqual(self.store.get_intervention(intervention_id).status, "delivered")

        failed_id = self.store.create_intervention(session_id, observation_id, "Second drift.")
        response = client.post(
            f"/interventions/{failed_id}/delivery",
            json={"ok": False, "error": "notification create failed"},
        )
        self.assertEqual(response.json()["status"], "delivery_failed")

        self.assertEqual(client.post("/interventions/int_missing/delivery", json={"ok": True}).status_code, 404)

    def test_end_returns_summary_and_deactivates_session(self) -> None:
        client = self._client()
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Plan a trip to Finland"})
        self._seed_observation(session_id, Verdict.OK)
        self._seed_observation(session_id, Verdict.DRIFT, url_host="youtube.com")

        summary = client.post("/sessions/current/end").json()
        self.assertEqual(summary["session_id"], session_id)
        self.assertIsNotNone(summary["ended_at"])
        self.assertEqual(summary["observations"], 2)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["drift"], 1)

        self.assertEqual(client.get("/sessions/current").status_code, 404)
        self.assertEqual(client.get("/sessions/current/state").status_code, 404)
        self.assertEqual(client.post("/sessions/current/end").status_code, 404)


if __name__ == "__main__":
    unittest.main()

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config
from apps.server.app.core.controllers.alignment import AlignmentController
from apps.server.app.main import create_app
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class ControllerHandshakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(self, controller: ControllerConfig) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            controller=controller,
        )
        client = TestClient(create_app(config=config, store=self.store))
        client.__enter__()
        return client

    def _start_goal(self, client: TestClient) -> str:
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        return session_id

    def _post_drift(self, client: TestClient, index: int) -> dict[str, object]:
        return client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/bread-{index}",
                    "title": f"Sourdough bread recipe {index}",
                },
            },
        ).json()

    def _post_ok(self, client: TestClient, index: int) -> dict[str, object]:
        return client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/api-{index}",
                    "title": f"Kibitzer observation API docs {index}",
                },
            },
        ).json()

    def test_coldstart_blocks_until_observation_gate_passes(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=3, cooldown_seconds=300))
        try:
            session_id = self._start_goal(client)

            first = self._post_drift(client, 1)
            second = self._post_drift(client, 2)
            third = self._post_drift(client, 3)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(second["action"], "none")
        self.assertEqual(third["action"], "request_excerpt")
        self.assertTrue(str(third["candidate_id"]).startswith("cand_"))
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.obs_count, 3)
        self.assertEqual(state.streak, 3)
        self.assertIsNone(state.last_intervention_ts)

    def test_ok_resets_streak_before_threshold(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=300))
        try:
            session_id = self._start_goal(client)
            first = self._post_drift(client, 1)
            ok = self._post_ok(client, 1)
            second = self._post_drift(client, 2)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(ok["verdict"], "OK")
        self.assertEqual(second["action"], "none")
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.obs_count, 3)
        self.assertEqual(state.streak, 1)

    def test_pending_candidate_blocks_repeated_request_excerpt_without_consuming_drift(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=3600))
        try:
            session_id = self._start_goal(client)
            first = self._post_drift(client, 1)
            second = self._post_drift(client, 2)
            third = self._post_drift(client, 3)
            fourth = self._post_drift(client, 4)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(second["action"], "request_excerpt")
        self.assertEqual(third["action"], "none")
        self.assertEqual(fourth["action"], "none")
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.streak, 4)
        self.assertIsNone(state.last_intervention_ts)
        candidate = self.store.get_intervention_candidate_for_observation(str(second["observation_id"]))
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate.status, "pending")

    def test_alignment_controller_uses_ewma_hysteresis(self) -> None:
        now = datetime.now(timezone.utc)
        controller = AlignmentController(
            alpha=0.5,
            theta_low=0.3,
            theta_high=0.6,
            cooldown_seconds=0,
            coldstart_observations=1,
        )

        controller.update(Verdict.OK, 0.8)
        self.assertAlmostEqual(controller.alignment_score or 0, 0.8)
        self.assertFalse(controller.should_intervene(now))

        controller.update(Verdict.DRIFT, 0.0)
        self.assertAlmostEqual(controller.alignment_score or 0, 0.4)
        self.assertFalse(controller.should_intervene(now))

        controller.update(Verdict.DRIFT, 0.0)
        self.assertAlmostEqual(controller.alignment_score or 0, 0.2)
        self.assertTrue(controller.should_intervene(now))

        controller.on_intervened(now)
        self.assertFalse(controller.should_intervene(now))

        controller.update(Verdict.DRIFT, 0.0)
        self.assertFalse(controller.should_intervene(now))

        controller.update(Verdict.OK, 1.0)
        self.assertFalse(controller.should_intervene(now))
        controller.update(Verdict.OK, 1.0)
        self.assertFalse(controller.drift_latched)

        controller.update(Verdict.DRIFT, 0.0)
        self.assertFalse(controller.should_intervene(now))
        controller.update(Verdict.DRIFT, 0.0)
        self.assertTrue(controller.should_intervene(now))

    def test_streak_controller_ignores_interleaved_drift(self) -> None:
        client = self._client(
            ControllerConfig(type="streak", k=3, coldstart_observations=1, cooldown_seconds=0)
        )
        try:
            session_id = self._start_goal(client)
            self._post_drift(client, 1)
            self._post_ok(client, 1)
            self._post_drift(client, 2)
            self._post_ok(client, 2)
            third = self._post_drift(client, 3)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(third["action"], "none")
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.obs_count, 5)
        self.assertEqual(state.streak, 1)

    def test_snooze_blocks_request_excerpt(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=0))
        try:
            session_id = self._start_goal(client)
            future = datetime.now(timezone.utc) + timedelta(minutes=15)
            self.store.save_controller_state(
                session_id=session_id,
                streak=0,
                obs_count=0,
                last_intervention_ts=None,
                snoozed_until=future,
            )
            first = self._post_drift(client, 1)
            second = self._post_drift(client, 2)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(second["action"], "none")
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.streak, 2)
        self.assertEqual(state.snoozed_until, future)

    def test_request_excerpt_event_is_logged_once(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=3600))
        try:
            session_id = self._start_goal(client)
            self._post_drift(client, 1)
            response = self._post_drift(client, 2)
        finally:
            client.__exit__(None, None, None)

        conn = sqlite3.connect(self.db_path)
        try:
            count = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE session_id = ? AND event_type = 'intervention.request_excerpt'",
                (session_id,),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(response["action"], "request_excerpt")
        self.assertEqual(count, 1)

    def test_expired_candidate_allows_a_new_request_without_losing_drift_evidence(self) -> None:
        client = self._client(ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=300))
        try:
            session_id = self._start_goal(client)
            first = self._post_drift(client, 1)
            conn = sqlite3.connect(self.db_path)
            try:
                conn.execute(
                    "UPDATE intervention_candidates SET expires_at = ? WHERE id = ?",
                    ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), first["candidate_id"]),
                )
                conn.commit()
            finally:
                conn.close()
            second = self._post_drift(client, 2)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "request_excerpt")
        self.assertEqual(second["action"], "request_excerpt")
        self.assertNotEqual(first["candidate_id"], second["candidate_id"])
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.streak, 2)
        self.assertIsNone(state.last_intervention_ts)


if __name__ == "__main__":
    unittest.main()

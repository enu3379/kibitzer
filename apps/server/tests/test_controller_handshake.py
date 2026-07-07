import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config
from apps.server.app.main import create_app
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
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.obs_count, 3)
        self.assertEqual(state.streak, 0)
        self.assertIsNotNone(state.last_intervention_ts)

    def test_ok_resets_streak_before_threshold(self) -> None:
        client = self._client(ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=300))
        try:
            session_id = self._start_goal(client)
            first = self._post_drift(client, 1)
            ok = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/api",
                        "title": "Kibitzer observation API docs",
                    },
                },
            ).json()
            second = self._post_drift(client, 2)
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(ok["verdict"], "OK")
        self.assertEqual(second["action"], "none")
        state = self.store.get_controller_state(session_id)
        self.assertEqual(state.obs_count, 3)
        self.assertEqual(state.streak, 1)

    def test_cooldown_blocks_repeated_request_excerpt(self) -> None:
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
        self.assertEqual(state.streak, 2)

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

        with sqlite3.connect(self.db_path) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE session_id = ? AND event_type = 'intervention.request_excerpt'",
                (session_id,),
            ).fetchone()[0]
        self.assertEqual(response["action"], "request_excerpt")
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()

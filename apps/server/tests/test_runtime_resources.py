import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class RuntimeResourcesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        self.config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
        )
        self.client = TestClient(create_app(config=self.config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_health_reports_idle_until_goal_starts_tracking(self) -> None:
        self.assertEqual(self.client.get("/health").json()["mode"], "idle")

        self.client.post("/sessions")

        self.assertEqual(self.client.get("/health").json()["mode"], "idle")

        goal_response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API"},
        )

        self.assertEqual(goal_response.status_code, 200)
        active_health = self.client.get("/health").json()
        self.assertEqual(active_health["mode"], "active")
        self.assertIsNotNone(active_health["active_since"])

    def test_session_end_releases_runtime_back_to_idle(self) -> None:
        self.client.post("/sessions")
        self.client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})

        response = self.client.post("/sessions/current/end")

        self.assertEqual(response.status_code, 200)
        health = self.client.get("/health").json()
        self.assertEqual(health["mode"], "idle")
        self.assertIsNone(health["active_since"])

    def test_goal_without_session_does_not_activate_runtime(self) -> None:
        response = self.client.post("/sessions/current/goal", json={"raw_text": "no session yet"})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get("/health").json()["mode"], "idle")


if __name__ == "__main__":
    unittest.main()

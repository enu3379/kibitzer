import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from apps.server.app.config import AppConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore
from apps.server.tests.support import TestClient


class DataDeletionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
        )
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_delete_requires_explicit_confirmation(self) -> None:
        self.client.post("/sessions")

        response = self.client.post("/data/delete", json={"confirm": "yes"})

        self.assertEqual(response.status_code, 422)
        self.assertIsNotNone(self.store.get_current_session())

    def test_delete_rejects_untrusted_origin(self) -> None:
        self.client.post("/sessions")

        response = self.client.post(
            "/data/delete",
            headers={"origin": "https://attacker.example"},
            json={"confirm": "DELETE"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertIsNotNone(self.store.get_current_session())

    def test_delete_removes_all_activity_and_keeps_settings(self) -> None:
        goal_text = "private goal deletion sentinel"
        title = "private title deletion sentinel"
        self.client.post("/sessions")
        self.client.post("/sessions/current/goal", json={"raw_text": goal_text})
        self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "idempotency_key": "delete_test_navigation",
                "payload": {
                    "url": "https://example.com/private?token=secret",
                    "title": title,
                },
            },
        )
        self.store.update_settings({"persona": "quiet_coach"})

        response = self.client.post("/data/delete", json={"confirm": "DELETE"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"deleted": True})
        self.assertIsNone(self.store.get_current_session())
        self.assertEqual(self.store.get_settings()["persona"], "quiet_coach")

        activity_tables = (
            "sessions",
            "goals",
            "goal_exemplars",
            "goal_derived_exemplars",
            "observations",
            "observation_requests",
            "controller_states",
            "interventions",
            "intervention_candidates",
            "feedback",
            "event_log",
            "attachment_states",
            "page_labels",
            "observation_excerpts",
            "drift_clock_states",
            "d7_prepared_reviews",
            "dwell_presence_events",
            "drift_page_dwell_states",
        )
        with closing(sqlite3.connect(self.db_path)) as conn:
            counts = {
                table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in activity_tables
            }
        self.assertEqual(counts, dict.fromkeys(activity_tables, 0))
        database_bytes = self.db_path.read_bytes()
        self.assertNotIn(goal_text.encode(), database_bytes)
        self.assertNotIn(title.encode(), database_bytes)


if __name__ == "__main__":
    unittest.main()

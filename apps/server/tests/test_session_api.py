import tempfile
import unittest
import sqlite3
from contextlib import closing
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import AppConfig, ServerConfig
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class SessionApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        config = AppConfig(server=ServerConfig(db_path=str(db_path)))
        app = create_app(config=config, store=SQLiteStore(db_path))
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_create_session_then_set_goal(self) -> None:
        session_response = self.client.post("/sessions")
        self.assertEqual(session_response.status_code, 201)
        session_id = session_response.json()["id"]

        goal_response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "write the Kibitzer observation API"},
        )
        self.assertEqual(goal_response.status_code, 200)
        self.assertEqual(goal_response.json()["session_id"], session_id)
        self.assertEqual(goal_response.json()["raw_text"], "write the Kibitzer observation API")

        current_response = self.client.get("/sessions/current")
        self.assertEqual(current_response.status_code, 200)
        self.assertEqual(current_response.json()["session"]["id"], session_id)
        self.assertNotIn("keywords", current_response.json()["goal"])

        db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        with closing(sqlite3.connect(db_path)) as conn:
            exemplar = conn.execute(
                "SELECT vector_json FROM goal_exemplars WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        self.assertIsNotNone(exemplar)
        self.assertIn("[", exemplar[0])

    def test_goal_requires_active_session(self) -> None:
        response = self.client.post("/sessions/current/goal", json={"raw_text": "no session yet"})

        self.assertEqual(response.status_code, 404)

    def test_goal_can_atomically_ensure_active_session(self) -> None:
        response = self.client.post(
            "/sessions/current/goal",
            params={"ensure_session": "true"},
            json={"raw_text": "start from this goal"},
        )

        self.assertEqual(response.status_code, 200)
        current = self.client.get("/sessions/current")
        self.assertEqual(current.status_code, 200)
        self.assertEqual(response.json()["session_id"], current.json()["session"]["id"])
        self.assertEqual(current.json()["goal"]["raw_text"], "start from this goal")

    def test_goal_ensure_preserves_existing_active_session(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]

        response = self.client.post(
            "/sessions/current/goal",
            params={"ensure_session": "true"},
            json={"raw_text": "keep this session"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["session_id"], session_id)
        self.assertEqual(self.client.get("/sessions/current").json()["session"]["id"], session_id)

    def test_goal_rejects_removed_keyword_field(self) -> None:
        self.client.post("/sessions")

        response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "write the Kibitzer API", "keywords": ["api"]},
        )

        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()

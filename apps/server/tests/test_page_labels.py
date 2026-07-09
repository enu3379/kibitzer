import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class PageLabelApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(self) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(k=3, coldstart_observations=1, cooldown_seconds=0),
        )
        client = TestClient(create_app(config=config, store=self.store))
        client.__enter__()
        return client

    def _start_goal(self, client: TestClient) -> str:
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        return session_id

    def _post_nav(self, client: TestClient, title: str, tab_id: int, ts: datetime) -> dict[str, object]:
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "ts": ts.isoformat(),
                "payload": {
                    "url": f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                    "tab_id": tab_id,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_latest_observation_for_tab_returns_verdict_and_diagnostics(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            first = self._post_nav(client, "Sourdough bread recipe", 77, base)
            second = self._post_nav(client, "Kibitzer observation API docs", 77, base + timedelta(seconds=1))
            latest = client.get("/observations/latest", params={"tab_id": 77})
            missing = client.get("/observations/latest", params={"tab_id": 88})
            client.post(f"/observations/{second['observation_id']}/label", json={"label": "drift"})
            relabeled = client.get("/observations/latest", params={"tab_id": 77})
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(latest.status_code, 200)
        body = latest.json()
        self.assertEqual(body["observation_id"], second["observation_id"])
        self.assertEqual(body["title"], "Kibitzer observation API docs")
        self.assertEqual(body["url_host"], "example.com")
        self.assertEqual(body["verdict"], "OK")
        self.assertIn("r0", body["features"])
        self.assertIn("exemplar_score", body["features"])
        self.assertIn("anchor_eligible", body["features"])
        self.assertEqual(body["features"]["tier_reached"], 0)
        self.assertAlmostEqual(body["tau_ok"], 0.15)
        self.assertIsNone(body["label"])
        self.assertNotEqual(first["observation_id"], second["observation_id"])
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(relabeled.status_code, 200)
        self.assertEqual(relabeled.json()["label"], "drift")

    def test_page_label_related_adds_exemplar_once_and_replaces_label(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            session_id = self._start_goal(client)
            drift = self._post_nav(client, "Sourdough bread recipe", 77, base)
            observation_id = str(drift["observation_id"])

            drift_label = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "drift"},
            )
            related = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            duplicate = client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(drift_label.status_code, 200)
        self.assertEqual(drift_label.json()["label"], "drift")
        self.assertIsNone(drift_label.json()["exemplar_count"])
        self.assertEqual(related.status_code, 200)
        self.assertEqual(related.json()["label"], "related")
        self.assertEqual(related.json()["exemplar_count"], 2)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json()["exemplar_count"], 2)
        self.assertEqual(self.store.goal_exemplar_count(session_id), 2)

        with closing(sqlite3.connect(self.db_path)) as conn:
            rows = conn.execute("SELECT observation_id, label FROM page_labels").fetchall()
        self.assertEqual(rows, [(observation_id, "related")])

    def test_page_label_rejects_observations_from_inactive_session(self) -> None:
        client = self._client()
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            observed = self._post_nav(client, "Sourdough bread recipe", 77, base)
            client.post("/sessions")
            response = client.post(
                f"/observations/{observed['observation_id']}/label",
                json={"label": "drift"},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()

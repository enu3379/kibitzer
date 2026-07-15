import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    CelebrationConfig,
    ControllerConfig,
    DeliveryConfig,
    GoalEnrichmentConfig,
    QuietHoursConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class AttachmentEmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            if "Anchor seed" in text:
                vectors.append([0.8, 0.6])
            elif "Drift page" in text:
                vectors.append([0.0, -1.0])
            elif "Anchor-only return" in text:
                vectors.append([0.0, 1.0])
            else:
                vectors.append([1.0, 0.0])
        return vectors


class AttachmentLoopTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        min_drift_minutes: int = 3,
        cooldown_seconds: int = 300,
        quiet_hours: QuietHoursConfig | None = None,
        embedding_provider: AttachmentEmbeddingProvider | None = None,
    ) -> TestClient:
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
            controller=ControllerConfig(k=2, coldstart_observations=1, cooldown_seconds=0),
            celebration=CelebrationConfig(
                min_drift_minutes=min_drift_minutes,
                cooldown_seconds=cooldown_seconds,
            ),
            delivery=DeliveryConfig(
                quiet_hours=quiet_hours or QuietHoursConfig(enabled=False),
            ),
        )
        client = TestClient(
            create_app(
                config=config,
                store=self.store,
                embedding_provider=embedding_provider,
            )
        )
        client.__enter__()
        return client

    def _start_goal(self, client: TestClient) -> str:
        session_id = client.post("/sessions").json()["id"]
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        return session_id

    def _post_nav(self, client: TestClient, title: str, ts: datetime) -> dict[str, object]:
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "ts": ts.isoformat(),
                "payload": {
                    "url": f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_celebration_fires_on_confirmed_drift_return_without_intervention(self) -> None:
        client = self._client(min_drift_minutes=3, cooldown_seconds=0)
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            session_id = self._start_goal(client)
            first = self._post_nav(client, "Sourdough bread recipe", base)
            second = self._post_nav(client, "Mechanical keyboard deals", base + timedelta(minutes=1))
            returned = self._post_nav(client, "Kibitzer observation API docs", base + timedelta(minutes=4))
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["action"], "none")
        self.assertEqual(second["action"], "request_excerpt")
        self.assertEqual(returned["action"], "notify")
        self.assertEqual(returned["kind"], "celebration")
        self.assertIsNone(returned["intervention_id"])
        self.assertIsInstance(returned["message"], str)
        self.assertTrue(returned["message"])

        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
            event = conn.execute(
                "SELECT payload_json FROM event_log WHERE event_type = 'celebration.delivered'"
            ).fetchone()[0]
        self.assertEqual(intervention_count, 0)
        self.assertEqual(json.loads(event)["return_minutes"], 4)
        self.assertEqual(self.store.get_controller_state(session_id).streak, 0)

    def test_anchor_only_ok_does_not_end_confirmed_drift(self) -> None:
        client = self._client(
            min_drift_minutes=3,
            cooldown_seconds=0,
            embedding_provider=AttachmentEmbeddingProvider(),
        )
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            self._post_nav(client, "Anchor seed", base)
            self._post_nav(client, "Drift page one", base + timedelta(minutes=1))
            self._post_nav(client, "Drift page two", base + timedelta(minutes=2))
            anchor_only = self._post_nav(
                client,
                "Anchor-only return",
                base + timedelta(minutes=5),
            )
            anchor_only_observation = self.store.get_observation(
                str(anchor_only["observation_id"])
            )

            with closing(sqlite3.connect(self.db_path)) as conn:
                state_after_anchor_only = conn.execute(
                    "SELECT drift_started_at, drift_confirmed_at FROM attachment_states"
                ).fetchone()
                celebration_count = conn.execute(
                    "SELECT COUNT(*) FROM event_log WHERE event_type = 'celebration.delivered'"
                ).fetchone()[0]

            real_return = self._post_nav(
                client,
                "Kibitzer real return",
                base + timedelta(minutes=6),
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(anchor_only["verdict"], "OK")
        self.assertIsNotNone(anchor_only_observation)
        assert anchor_only_observation is not None
        self.assertIs(anchor_only_observation.features["anchor_eligible"], False)
        self.assertEqual(anchor_only["action"], "none")
        self.assertIsNotNone(state_after_anchor_only)
        assert state_after_anchor_only is not None
        self.assertTrue(all(state_after_anchor_only))
        self.assertEqual(celebration_count, 0)
        self.assertEqual(real_return["action"], "notify")
        self.assertEqual(real_return["kind"], "celebration")

    def test_celebration_requires_minimum_confirmed_drift_duration(self) -> None:
        client = self._client(min_drift_minutes=3, cooldown_seconds=0)
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            self._post_nav(client, "Sourdough bread recipe", base)
            self._post_nav(client, "Mechanical keyboard deals", base + timedelta(seconds=30))
            returned = self._post_nav(client, "Kibitzer observation API docs", base + timedelta(minutes=2))
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(returned["action"], "none")
        with closing(sqlite3.connect(self.db_path)) as conn:
            event_count = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'celebration.delivered'"
            ).fetchone()[0]
        self.assertEqual(event_count, 0)

    def test_invalid_stored_quiet_hours_suppress_celebration(self) -> None:
        client = self._client(min_drift_minutes=3, cooldown_seconds=0)
        base = datetime(2026, 7, 8, 0, 0, tzinfo=timezone.utc)
        try:
            self._start_goal(client)
            self.store.update_settings(
                {"quiet_hours": {"enabled": True, "start": "invalid", "end": "07:00"}}
            )
            self._post_nav(client, "Sourdough bread recipe", base)
            self._post_nav(client, "Mechanical keyboard deals", base + timedelta(minutes=1))
            returned = self._post_nav(
                client,
                "Kibitzer observation API docs",
                base + timedelta(minutes=4),
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(returned["action"], "none")
        with closing(sqlite3.connect(self.db_path)) as conn:
            event_count = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'celebration.delivered'"
            ).fetchone()[0]
        self.assertEqual(event_count, 0)


if __name__ == "__main__":
    unittest.main()

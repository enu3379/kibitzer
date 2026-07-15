import hashlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ServerConfig
from apps.server.app.core.normalization import normalize_browser_nav
from apps.server.app.main import create_app
from apps.server.app.schemas import RawObservation
from apps.server.app.storage.sqlite import SQLiteStore


class ObservationIntakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(server=ServerConfig(db_path=str(self.db_path)))
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_normalize_browser_nav_minimizes_url(self) -> None:
        raw = RawObservation.model_validate(
            {
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/private/path?token=secret#fragment",
                    "title": "  Example Page  ",
                    "tab_id": 42,
                },
            }
        )

        observation = normalize_browser_nav(raw, "sess_test")

        self.assertEqual(observation.session_id, "sess_test")
        self.assertEqual(observation.source, "browser_nav")
        self.assertEqual(observation.payload["url_host"], "example.com")
        self.assertEqual(observation.payload["title"], "Example Page")
        self.assertEqual(observation.payload["tab_id"], 42)
        self.assertEqual(
            observation.payload["url_path_hash"],
            hashlib.sha256(b"/private/path?token=secret#fragment").hexdigest(),
        )
        self.assertNotIn("url", observation.payload)

    def test_browser_nav_without_session_is_noop(self) -> None:
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {"url": "https://example.com/a", "title": "Example"},
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "none")
        self.assertIsNone(response.json()["observation_id"])

    def test_browser_nav_with_session_records_minimized_observation(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]

        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://docs.example.com/deep/path?api_key=secret#frag",
                    "title": "Docs",
                    "tab_id": 7,
                },
            },
        )

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["action"], "none")
        self.assertTrue(body["observation_id"].startswith("obs_"))

        observations = self.store.list_observations(session_id)
        self.assertEqual(len(observations), 1)
        self.assertEqual(observations[0].id, body["observation_id"])
        self.assertEqual(observations[0].url_host, "docs.example.com")
        self.assertEqual(observations[0].title, "Docs")
        self.assertEqual(observations[0].tab_id, 7)

        with closing(sqlite3.connect(self.db_path)) as conn:
            row = conn.execute(
                "SELECT url_path_hash, features_json FROM observations WHERE id = ?",
                (body["observation_id"],),
            ).fetchone()
            event_payload = conn.execute(
                "SELECT payload_json FROM event_log WHERE event_type = 'observation.recorded'"
            ).fetchone()[0]
        self.assertEqual(len(row[0]), 64)
        self.assertEqual(json.loads(row[1])["tier_reached"], None)
        self.assertNotIn("api_key", event_payload)
        self.assertNotIn("/deep/path", event_payload)

    def test_browser_nav_idempotency_key_replays_completed_result(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]
        body = {
            "source": "browser_nav",
            "idempotency_key": "nav.7.12345",
            "payload": {
                "url": "https://docs.example.com/idempotent?secret=not-stored",
                "title": "Idempotent Docs",
                "tab_id": 7,
            },
        }

        first = self.client.post("/observations/browser-nav", json=body)
        second = self.client.post("/observations/browser-nav", json=body)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(len(self.store.list_observations(session_id)), 1)
        with closing(sqlite3.connect(self.db_path)) as conn:
            recorded = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'observation.recorded'"
            ).fetchone()[0]
            request_row = conn.execute(
                "SELECT request_fingerprint, result_json FROM observation_requests"
            ).fetchone()
        self.assertEqual(recorded, 1)
        self.assertEqual(len(request_row[0]), 64)
        self.assertNotIn("secret", request_row[1])

    def test_browser_nav_rejects_idempotency_key_reuse_for_different_request(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]
        first = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "idempotency_key": "nav-reused-key",
                "payload": {"url": "https://example.com/first", "title": "First"},
            },
        )
        second = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "idempotency_key": "nav-reused-key",
                "payload": {"url": "https://example.com/second", "title": "Second"},
            },
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(len(self.store.list_observations(session_id)), 1)
        self.assertNotIn("example.com", second.json()["detail"])

    def test_browser_nav_failure_releases_unfinished_idempotency_claim(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]
        body = {
            "source": "browser_nav",
            "idempotency_key": "nav-retry-after-failure",
            "payload": {"url": "https://example.com/retry", "title": "Retry"},
        }

        with patch(
            "apps.server.app.api.observations._ingest_browser_nav_once",
            side_effect=RuntimeError("synthetic intake failure"),
        ):
            with self.assertRaises(RuntimeError):
                self.client.post("/observations/browser-nav", json=body)

        with closing(sqlite3.connect(self.db_path)) as conn:
            unfinished = conn.execute("SELECT COUNT(*) FROM observation_requests").fetchone()[0]
        self.assertEqual(unfinished, 0)

        retry = self.client.post("/observations/browser-nav", json=body)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(len(self.store.list_observations(session_id)), 1)

    def test_sensitive_browser_nav_with_session_is_dropped_without_raw_url_content(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]

        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://checkout.stripe.com/pay?client_secret=secret#card",
                    "title": "Payment Secret",
                    "tab_id": 8,
                },
            },
        )

        body = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(body["action"], "none")
        self.assertIsNone(body["observation_id"])
        self.assertEqual(self.store.list_observations(session_id), [])

        with closing(sqlite3.connect(self.db_path)) as conn:
            event = conn.execute(
                "SELECT session_id, payload_json FROM event_log WHERE event_type = 'observation.dropped'"
            ).fetchone()
        payload = json.loads(event[1])
        self.assertEqual(event[0], session_id)
        self.assertEqual(payload["source"], "browser_nav")
        self.assertEqual(payload["url_host"], "checkout.stripe.com")
        self.assertEqual(payload["reason"], "blocked_host:checkout.stripe.com")
        self.assertNotIn("client_secret", event[1])
        self.assertNotIn("/pay", event[1])
        self.assertNotIn("Payment Secret", event[1])

    def test_sensitive_browser_nav_without_session_still_logs_drop_minimally(self) -> None:
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://github.com/settings/tokens?token=secret",
                    "title": "Token settings",
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["observation_id"])

        with closing(sqlite3.connect(self.db_path)) as conn:
            observation_count = conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
            event = conn.execute(
                "SELECT session_id, payload_json FROM event_log WHERE event_type = 'observation.dropped'"
            ).fetchone()
        payload = json.loads(event[1])
        self.assertEqual(observation_count, 0)
        self.assertIsNone(event[0])
        self.assertEqual(payload["url_host"], "github.com")
        self.assertEqual(payload["reason"], "blocked_host:github.com/settings")
        self.assertNotIn("token=secret", event[1])
        self.assertNotIn("/settings/tokens", event[1])


if __name__ == "__main__":
    unittest.main()

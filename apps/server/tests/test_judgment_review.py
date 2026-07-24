import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    GoalEnrichmentConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore
from scripts.judgment_review import list_sessions, make_handler, save_label, session_detail


class _SuccessfulResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None


class JudgmentReviewTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
        )
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _start_goal(self, raw_text: str = "Kibitzer observation API") -> str:
        session_id = self.client.post("/sessions").json()["id"]
        response = self.client.post("/sessions/current/goal", json={"raw_text": raw_text})
        self.assertEqual(response.status_code, 200)
        return session_id

    def _observe(self, title: str = "Sourdough bread recipe") -> str:
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                    "tab_id": 1,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["observation_id"]

    def test_past_session_labels_are_record_only(self) -> None:
        session_id = self._start_goal()
        observation_id = self._observe()
        related = self.client.post(
            f"/observations/{observation_id}/label",
            json={"label": "related"},
        )
        self.assertEqual(related.status_code, 200)
        exemplars_after_live_label = self.store.goal_exemplar_count(session_id)
        self.assertGreaterEqual(exemplars_after_live_label, 1)

        self._start_goal("another goal")
        saved = save_label(str(self.db_path), "http://127.0.0.1:1", observation_id, "drift")

        self.assertEqual(saved, {"ok": True, "via": "direct-record-only"})
        self.assertEqual(self.store.page_label_for_observation(observation_id), "drift")
        self.assertEqual(self.store.goal_exemplar_count(session_id), exemplars_after_live_label)

        save_label(str(self.db_path), "http://127.0.0.1:1", observation_id, "related")
        self.assertEqual(self.store.page_label_for_observation(observation_id), "related")
        self.assertEqual(self.store.goal_exemplar_count(session_id), exemplars_after_live_label)

    def test_active_session_label_uses_app_server(self) -> None:
        self._start_goal()
        observation_id = self._observe()

        with patch("scripts.judgment_review.urllib.request.urlopen", return_value=_SuccessfulResponse()) as opened:
            saved = save_label(str(self.db_path), "http://127.0.0.1:8765/", observation_id, "related")

        self.assertEqual(saved, {"ok": True, "via": "server"})
        request = opened.call_args.args[0]
        self.assertEqual(
            request.full_url,
            f"http://127.0.0.1:8765/observations/{observation_id}/label",
        )
        self.assertEqual(json.loads(request.data), {"label": "related"})

    def test_active_session_does_not_silently_fall_back_when_server_is_down(self) -> None:
        self._start_goal()
        observation_id = self._observe()

        with patch(
            "scripts.judgment_review.urllib.request.urlopen",
            side_effect=OSError("connection refused"),
        ):
            saved = save_label(str(self.db_path), "http://127.0.0.1:8765", observation_id, "related")

        self.assertFalse(saved["ok"])
        self.assertIn("active session requires the app server", saved["error"])
        self.assertIsNone(self.store.page_label_for_observation(observation_id))

    def test_session_queries_expose_judgment_trail_without_writing(self) -> None:
        session_id = self._start_goal()
        observation_id = self._observe()

        sessions = list_sessions(str(self.db_path))
        detail = session_detail(str(self.db_path), session_id)

        self.assertEqual(sessions[0]["id"], session_id)
        self.assertEqual(sessions[0]["obs"], 1)
        self.assertEqual(detail["goal"], "Kibitzer observation API")
        self.assertTrue(detail["is_active"])
        self.assertEqual(detail["observations"][0]["id"], observation_id)
        self.assertIn(detail["observations"][0]["verdict"], {"OK", "DRIFT"})
        self.assertIsNone(self.store.page_label_for_observation(observation_id))

    def test_http_handler_serves_page_and_read_apis(self) -> None:
        session_id = self._start_goal()
        self._observe()
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            make_handler(str(self.db_path), "http://127.0.0.1:8765"),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(base_url, timeout=3) as response:
                page = response.read().decode()
                cache_control = response.headers["cache-control"]
                content_security_policy = response.headers["content-security-policy"]
            with urllib.request.urlopen(f"{base_url}/api/sessions", timeout=3) as response:
                sessions = json.load(response)
            with urllib.request.urlopen(f"{base_url}/api/session?id={session_id}", timeout=3) as response:
                detail = json.load(response)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

        self.assertIn("Kibitzer 판정 리뷰", page)
        self.assertEqual(cache_control, "no-store")
        self.assertIn("frame-ancestors 'none'", content_security_policy)
        self.assertEqual(sessions[0]["id"], session_id)
        self.assertEqual(detail["session_id"], session_id)

    def test_invalid_label_is_rejected(self) -> None:
        self._start_goal()
        observation_id = self._observe()

        result = save_label(str(self.db_path), "http://127.0.0.1:8765", observation_id, "maybe")

        self.assertEqual(result, {"ok": False, "error": "invalid label"})
        self.assertIsNone(self.store.page_label_for_observation(observation_id))


if __name__ == "__main__":
    unittest.main()

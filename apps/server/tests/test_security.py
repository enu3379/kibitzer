import os
import stat
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient as FastAPITestClient
from pydantic import ValidationError

from apps.server.app.config import AppConfig, ServerConfig, harden_local_secret_file
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore
from apps.server.tests.support import TestClient


class LocalApiSecurityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "private" / "kibitzer.sqlite3"
        config = AppConfig(
            server=ServerConfig(
                auth_enabled=False,
                db_path=str(self.db_path),
                max_request_body_bytes=262144,
            )
        )
        self.app = create_app(config=config, store=SQLiteStore(self.db_path))
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_rejects_untrusted_host(self) -> None:
        client = FastAPITestClient(self.app, base_url="http://attacker.example")

        response = client.get("/health")

        self.assertEqual(response.status_code, 400)

    def test_rejects_cross_origin_mutation(self) -> None:
        response = self.client.post(
            "/sessions",
            headers={"origin": "https://attacker.example"},
            json={},
        )

        self.assertEqual(response.status_code, 403)

    def test_rejects_cross_site_request_without_origin(self) -> None:
        response = self.client.post(
            "/sessions",
            headers={"sec-fetch-site": "cross-site"},
            json={},
        )

        self.assertEqual(response.status_code, 403)

    def test_rejects_form_and_bodyless_mutations(self) -> None:
        form_response = self.client.post("/sessions", data={})
        bodyless_response = self.client.post("/sessions")

        self.assertEqual(form_response.status_code, 415)
        self.assertEqual(bodyless_response.status_code, 415)

    def test_allows_extension_and_loopback_origins(self) -> None:
        extension_response = self.client.post(
            "/sessions",
            headers={"origin": "chrome-extension://pkfnofjnjaojkamahhoipkeaiaecdkgc"},
            json={},
        )
        loopback_response = self.client.post(
            "/sessions/current/end",
            headers={"origin": "http://127.0.0.1:8765"},
            json={},
        )

        self.assertEqual(extension_response.status_code, 201)
        self.assertEqual(loopback_response.status_code, 200)

        wrong_extension = self.client.post(
            "/sessions",
            headers={"origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            json={},
        )
        self.assertEqual(wrong_extension.status_code, 403)

    def test_rejects_oversized_request_before_validation(self) -> None:
        response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "x" * 300000},
        )

        self.assertEqual(response.status_code, 413)

    def test_rejects_unbounded_goal_title_and_keyword_inputs(self) -> None:
        self.client.post("/sessions", json={})

        goal_response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "x" * 10001},
        )
        title_response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {"url": "https://example.com/", "title": "x" * 2001},
            },
        )
        keyword_response = self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "bounded", "keywords": [f"keyword-{index}" for index in range(51)]},
        )

        self.assertEqual(goal_response.status_code, 422)
        self.assertEqual(title_response.status_code, 422)
        self.assertEqual(keyword_response.status_code, 422)

    def test_disables_interactive_api_docs_by_default(self) -> None:
        self.assertEqual(self.client.get("/docs").status_code, 404)
        self.assertEqual(self.client.get("/redoc").status_code, 404)
        self.assertEqual(self.client.get("/openapi.json").status_code, 404)

    def test_activity_deletion_requires_explicit_confirmation(self) -> None:
        self.client.post("/sessions", json={})
        self.client.post("/sessions/current/goal", json={"raw_text": "private goal"})

        rejected = self.client.post("/data/delete", json={"confirm": "yes"})
        deleted = self.client.post("/data/delete", json={"confirm": "DELETE"})

        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(self.client.get("/sessions/current").status_code, 404)

    def test_rejects_host_allowlists_with_ports_or_wildcards(self) -> None:
        for host in ("127.0.0.1:8765", "*", "attacker.example"):
            with self.subTest(host=host), self.assertRaises(ValidationError):
                ServerConfig(allowed_hosts=[host])

    def test_rejects_non_exact_extension_origins(self) -> None:
        for origin in (
            "chrome-extension://*",
            "https://example.com",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ):
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                ServerConfig(allowed_origins=[origin])

    @unittest.skipIf(os.name == "nt", "POSIX permission bits are not authoritative on Windows")
    def test_creates_private_database_file(self) -> None:
        mode = stat.S_IMODE(self.db_path.stat().st_mode)

        self.assertEqual(mode, 0o600)

    @unittest.skipIf(os.name == "nt", "POSIX permission bits are not authoritative on Windows")
    def test_hardens_existing_local_secret_file(self) -> None:
        secret = Path(self.tmpdir.name) / ".env"
        secret.write_text("API_KEY=secret\n", encoding="utf-8")
        secret.chmod(0o644)

        harden_local_secret_file(secret)

        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()

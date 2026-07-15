import base64
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from apps.server.app.config import (
    AppConfig,
    DeliveryConfig,
    SecurityConfig,
    ServerConfig,
    Tier1Config,
    Tier1SendConfig,
    Tier2Config,
    load_config,
)
from apps.server.app.main import create_app
from apps.server.app.ports import PORT_CANDIDATES
from apps.server.app.storage.sqlite import SQLiteStore


PRODUCTION_EXTENSION_ID = "a" * 32
DEVELOPMENT_EXTENSION_ID = "b" * 32
UNRELATED_EXTENSION_ID = "c" * 32


class SecurityBoundaryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        config = AppConfig(
            server=ServerConfig(db_path=str(db_path)),
            security=SecurityConfig(
                allowed_extension_ids=[PRODUCTION_EXTENSION_ID, DEVELOPMENT_EXTENSION_ID]
            ),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
        )
        self.port = PORT_CANDIDATES[1]
        self.client = TestClient(
            create_app(config=config, store=SQLiteStore(db_path)),
            base_url=f"http://127.0.0.1:{self.port}",
        )
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_loopback_hosts_accept_non_default_ports_and_foreign_hosts_fail(self) -> None:
        self.assertEqual(self.client.get("/identity").status_code, 200)
        self.assertEqual(
            self.client.get(
                "/identity", headers={"host": f"localhost:{PORT_CANDIDATES[2]}"}
            ).status_code,
            200,
        )
        for host in ("attacker.example", "127.0.0.1.attacker.example"):
            with self.subTest(host=host):
                self.assertEqual(
                    self.client.get("/identity", headers={"host": host}).status_code,
                    400,
                )

    def test_only_configured_extension_origins_can_mutate(self) -> None:
        for extension_id in (PRODUCTION_EXTENSION_ID, DEVELOPMENT_EXTENSION_ID):
            with self.subTest(extension_id=extension_id):
                response = self.client.post(
                    "/sessions",
                    headers={"origin": f"chrome-extension://{extension_id}"},
                )
                self.assertEqual(response.status_code, 201)

        for origin in (
            f"chrome-extension://{UNRELATED_EXTENSION_ID}",
            "https://attacker.example",
            "null",
        ):
            with self.subTest(origin=origin):
                response = self.client.post("/sessions", headers={"origin": origin})
                self.assertEqual(response.status_code, 403)

    def test_same_origin_local_ui_must_match_host_and_port_exactly(self) -> None:
        for host in (
            f"127.0.0.1:{self.port}",
            f"localhost:{PORT_CANDIDATES[2]}",
        ):
            with self.subTest(host=host):
                response = self.client.post(
                    "/sessions",
                    headers={"host": host, "origin": f"http://{host}"},
                )
                self.assertEqual(response.status_code, 201)

        for host, origin in (
            (f"127.0.0.1:{self.port}", f"http://127.0.0.1:{PORT_CANDIDATES[0]}"),
            (f"localhost:{self.port}", f"http://127.0.0.1:{self.port}"),
        ):
            with self.subTest(host=host, origin=origin):
                response = self.client.post(
                    "/sessions",
                    headers={"host": host, "origin": origin},
                )
                self.assertEqual(response.status_code, 403)

    def test_absent_origin_remains_available_to_loopback_cli_clients(self) -> None:
        self.assertEqual(self.client.post("/sessions").status_code, 201)
        rejected = self.client.post(
            "/sessions",
            headers={"sec-fetch-site": "cross-site"},
        )
        self.assertEqual(rejected.status_code, 403)

    def test_origin_boundary_also_covers_put_routes(self) -> None:
        rejected = self.client.put(
            "/settings",
            json={},
            headers={"origin": "https://attacker.example"},
        )
        self.assertEqual(rejected.status_code, 403)

        allowed = self.client.put(
            "/settings",
            json={},
            headers={"origin": f"chrome-extension://{DEVELOPMENT_EXTENSION_ID}"},
        )
        self.assertEqual(allowed.status_code, 200)


class SecurityConfigTest(unittest.TestCase):
    def test_removed_noop_config_fields_are_rejected(self) -> None:
        cases = (
            (ServerConfig, {"host": "0.0.0.0"}),
            (Tier1SendConfig, {"url_path": True}),
            (Tier1SendConfig, {"page_excerpt": True}),
            (DeliveryConfig, {"channel": "webhook"}),
        )
        for model, value in cases:
            with self.subTest(model=model.__name__, value=value), self.assertRaises(ValidationError):
                model.model_validate(value)

    def test_default_allowlist_matches_the_stable_manifest_key(self) -> None:
        manifest = json.loads(Path("apps/extension/manifest.json").read_text(encoding="utf-8"))
        digest = hashlib.sha256(base64.b64decode(manifest["key"])).digest()[:16]
        extension_id = "".join(
            chr(ord("a") + nibble)
            for byte in digest
            for nibble in (byte >> 4, byte & 0x0F)
        )
        with patch.dict(os.environ, {"KIBITZER_EXTENSION_IDS": ""}):
            config = load_config()

        self.assertIn(extension_id, config.security.allowed_extension_ids)

    def test_env_extension_ids_override_yaml_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "config.yaml"
            path.write_text(
                "security:\n  allowed_extension_ids:\n    - dddddddddddddddddddddddddddddddd\n",
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "KIBITZER_EXTENSION_IDS": (
                        f"{PRODUCTION_EXTENSION_ID}, {DEVELOPMENT_EXTENSION_ID},"
                        f"{PRODUCTION_EXTENSION_ID}"
                    )
                },
            ):
                config = load_config(path)

        self.assertEqual(
            config.security.allowed_extension_ids,
            [PRODUCTION_EXTENSION_ID, DEVELOPMENT_EXTENSION_ID],
        )

    def test_invalid_extension_id_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            SecurityConfig(allowed_extension_ids=["not-an-extension-id"])


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import stat
import tempfile
import time
import unittest
from pathlib import Path

from apps.server.app.config import AppConfig, ServerConfig
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore
from apps.server.tests.support import TestClient


EXTENSION_ORIGIN = "chrome-extension://pkfnofjnjaojkamahhoipkeaiaecdkgc"


class LocalApiAuthenticationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        root = Path(self.tmpdir.name)
        self.key_path = root / "auth.key"
        self.code_path = root / "pairing.code"
        db_path = root / "kibitzer.sqlite3"
        config = AppConfig(
            server=ServerConfig(
                db_path=str(db_path),
                auth_key_path=str(self.key_path),
                pairing_code_path=str(self.code_path),
            )
        )
        self.app = create_app(config=config, store=SQLiteStore(db_path))
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_pairing_requires_exact_extension_origin(self) -> None:
        payload, _ = self._pairing_payload()

        missing_origin = self.client.post("/auth/pair", json=payload)
        wrong_origin = self.client.post(
            "/auth/pair",
            headers={"origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            json=payload,
        )

        self.assertEqual(missing_origin.status_code, 403)
        self.assertEqual(wrong_origin.status_code, 403)
        self.assertFalse(self.key_path.exists())

    def test_signed_request_gets_verified_response_and_cannot_be_replayed(self) -> None:
        secret = self._pair()
        headers = self._signed_headers(secret, "GET", "/sessions/current/state", b"")

        response = self.client.get("/sessions/current/state", headers=headers)

        self.assertEqual(response.status_code, 404)
        expected_proof = hmac.new(
            secret,
            (
                "kibitzer-response-v1\n"
                f"{headers['x-kibitzer-nonce']}\n{response.status_code}\n"
                f"{hashlib.sha256(response.content).hexdigest()}"
            ).encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(
            hmac.compare_digest(expected_proof, response.headers["x-kibitzer-response-proof"])
        )

        replay = self.client.get("/sessions/current/state", headers=headers)
        self.assertEqual(replay.status_code, 401)
        self.assertNotIn("x-kibitzer-response-proof", replay.headers)

    def test_rejects_unsigned_stale_and_tampered_requests(self) -> None:
        secret = self._pair()

        unsigned = self.client.get("/sessions/current/state")
        stale = self.client.get(
            "/sessions/current/state",
            headers=self._signed_headers(
                secret,
                "GET",
                "/sessions/current/state",
                b"",
                timestamp=int(time.time()) - 600,
            ),
        )
        tampered = self._signed_headers(secret, "GET", "/sessions/current/state", b"")
        tampered["x-kibitzer-signature"] = "0" * 64
        tampered_response = self.client.get("/sessions/current/state", headers=tampered)

        self.assertEqual(unsigned.status_code, 401)
        self.assertEqual(stale.status_code, 401)
        self.assertEqual(tampered_response.status_code, 401)

    def test_signed_mutation_binds_the_exact_request_body(self) -> None:
        secret = self._pair()
        body = b"{}"
        headers = {
            **self._signed_headers(secret, "POST", "/sessions", body),
            "content-type": "application/json",
            "origin": EXTENSION_ORIGIN,
        }

        created = self.client.post("/sessions", headers=headers, content=body)

        self.assertEqual(created.status_code, 201)
        tampered_headers = {
            **self._signed_headers(secret, "POST", "/sessions/current/goal", body),
            "content-type": "application/json",
            "origin": EXTENSION_ORIGIN,
        }
        tampered = self.client.post(
            "/sessions/current/goal",
            headers=tampered_headers,
            content=b'{"raw_text":"changed"}',
        )
        self.assertEqual(tampered.status_code, 401)

    def test_pairing_secret_is_private_and_code_is_single_use(self) -> None:
        secret = self._pair()

        self.assertEqual(self.key_path.read_text(encoding="ascii").strip(), secret.hex())
        self.assertFalse(self.code_path.exists())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.key_path.stat().st_mode), 0o600)
        second_payload, _ = self._pairing_payload(code="0" * 64)
        second = self.client.post(
            "/auth/pair",
            headers={"origin": EXTENSION_ORIGIN},
            json=second_payload,
        )
        self.assertEqual(second.status_code, 409)

    def _pair(self) -> bytes:
        payload, secret = self._pairing_payload()
        response = self.client.post(
            "/auth/pair",
            headers={"origin": EXTENSION_ORIGIN},
            json=payload,
        )
        self.assertEqual(response.status_code, 200, response.text)
        expected = hmac.new(
            secret,
            f"kibitzer-pair-response-v1\n{payload['client_nonce']}".encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(hmac.compare_digest(expected, response.json()["proof"]))
        return secret

    def _pairing_payload(self, *, code: str | None = None) -> tuple[dict[str, str], bytes]:
        pairing_code = code or self.code_path.read_text(encoding="ascii").strip()
        pair_key = hashlib.sha256(pairing_code.encode("ascii")).digest()
        client_nonce = "1" * 32
        secret = bytes(range(32))
        mask = hmac.new(
            pair_key,
            f"kibitzer-pair-wrap-v1\n{client_nonce}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        wrapped = bytes(left ^ right for left, right in zip(secret, mask)).hex()
        tag = hmac.new(
            pair_key,
            f"kibitzer-pair-request-v1\n{client_nonce}\n{wrapped}".encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        return {"client_nonce": client_nonce, "wrapped_secret": wrapped, "tag": tag}, secret

    @staticmethod
    def _signed_headers(
        secret: bytes,
        method: str,
        path: str,
        body: bytes,
        *,
        timestamp: int | None = None,
    ) -> dict[str, str]:
        timestamp_text = str(timestamp if timestamp is not None else int(time.time()))
        nonce = secrets.token_hex(16)
        canonical = (
            f"kibitzer-request-v1\n{timestamp_text}\n{nonce}\n{method}\n{path}\n"
            f"{hashlib.sha256(body).hexdigest()}"
        ).encode("ascii")
        return {
            "x-kibitzer-timestamp": timestamp_text,
            "x-kibitzer-nonce": nonce,
            "x-kibitzer-signature": hmac.new(secret, canonical, hashlib.sha256).hexdigest(),
        }


if __name__ == "__main__":
    unittest.main()

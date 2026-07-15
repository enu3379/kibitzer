from __future__ import annotations

import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import local_api


class _FakeResponse:
    def __init__(self, body: bytes, proof: str) -> None:
        self.status = 200
        self.headers = {"x-kibitzer-response-proof": proof}
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class SignedSmokeClientTest(unittest.TestCase):
    def test_signs_requests_and_verifies_responses(self) -> None:
        secret = bytes(range(32))
        response_body = json.dumps({"created": True}).encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / "auth.key"
            key_path.write_text(f"{secret.hex()}\n", encoding="ascii")

            def fake_urlopen(request: object, timeout: int) -> _FakeResponse:
                del timeout
                headers = {
                    key.lower(): value for key, value in request.header_items()  # type: ignore[attr-defined]
                }
                timestamp = headers["x-kibitzer-timestamp"]
                nonce = headers["x-kibitzer-nonce"]
                body = request.data  # type: ignore[attr-defined]
                canonical = (
                    f"kibitzer-request-v1\n{timestamp}\n{nonce}\nPOST\n/sessions\n"
                    f"{hashlib.sha256(body).hexdigest()}"
                ).encode("ascii")
                expected_signature = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
                self.assertTrue(
                    hmac.compare_digest(expected_signature, headers["x-kibitzer-signature"])
                )
                proof = hmac.new(
                    secret,
                    (
                        f"kibitzer-response-v1\n{nonce}\n200\n"
                        f"{hashlib.sha256(response_body).hexdigest()}"
                    ).encode("ascii"),
                    hashlib.sha256,
                ).hexdigest()
                return _FakeResponse(response_body, proof)

            with (
                patch.object(local_api, "AUTH_KEY_PATH", key_path),
                patch.object(local_api.urllib.request, "urlopen", side_effect=fake_urlopen),
            ):
                self.assertEqual(local_api.post_json("/sessions"), {"created": True})

    def test_rejects_an_unverified_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / "auth.key"
            key_path.write_text(f"{'ab' * 32}\n", encoding="ascii")
            with (
                patch.object(local_api, "AUTH_KEY_PATH", key_path),
                patch.object(
                    local_api.urllib.request,
                    "urlopen",
                    return_value=_FakeResponse(b"{}", "0" * 64),
                ),
                self.assertRaisesRegex(SystemExit, "unverified"),
            ):
                local_api.post_json("/sessions")


if __name__ == "__main__":
    unittest.main()

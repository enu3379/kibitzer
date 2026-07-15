from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("KIBITZER_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
AUTH_KEY_PATH = Path(os.environ.get("KIBITZER_AUTH_KEY_PATH", ROOT / "data" / "auth.key"))
HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def post_json(path: str, payload: dict[str, object] | None = None, timeout: int = 60) -> dict[str, object]:
    secret = _load_secret()
    data = json.dumps(payload or {}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    url = f"{BASE_URL}{path}"
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise SystemExit("KIBITZER_BASE_URL must be an HTTP loopback URL")
    path_and_query = parsed.path or "/"
    if parsed.query:
        path_and_query += f"?{parsed.query}"
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(data).hexdigest()
    canonical = (
        f"kibitzer-request-v1\n{timestamp}\n{nonce}\nPOST\n{path_and_query}\n{body_hash}"
    ).encode("utf-8")
    signature = hmac.new(secret, canonical, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "content-type": "application/json",
            "x-kibitzer-timestamp": timestamp,
            "x-kibitzer-nonce": nonce,
            "x-kibitzer-signature": signature,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_body = response.read()
            proof = response.headers.get("x-kibitzer-response-proof", "")
            expected = hmac.new(
                secret,
                (
                    f"kibitzer-response-v1\n{nonce}\n{response.status}\n"
                    f"{hashlib.sha256(response_body).hexdigest()}"
                ).encode("ascii"),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(expected, proof):
                raise SystemExit(f"unverified local API response for {path}")
            value = json.loads(response_body)
            if not isinstance(value, dict):
                raise SystemExit(f"invalid local API response for {path}")
            return value
    except urllib.error.URLError as exc:
        raise SystemExit(f"request failed for {path}: {exc}") from exc


def _load_secret() -> bytes:
    try:
        value = AUTH_KEY_PATH.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise SystemExit(
            f"local API pairing key is unavailable at {AUTH_KEY_PATH}; pair the extension first"
        ) from exc
    if not HEX_64.fullmatch(value):
        raise SystemExit(f"invalid local API pairing key at {AUTH_KEY_PATH}")
    return bytes.fromhex(value)

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from pathlib import Path


_HEX_32 = re.compile(r"^[0-9a-f]{32}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_PAIR_REQUEST_CONTEXT = "kibitzer-pair-request-v1"
_PAIR_WRAP_CONTEXT = "kibitzer-pair-wrap-v1"
_PAIR_RESPONSE_CONTEXT = "kibitzer-pair-response-v1"
_REQUEST_CONTEXT = "kibitzer-request-v1"
_RESPONSE_CONTEXT = "kibitzer-response-v1"


class PairingError(RuntimeError):
    pass


class LoopbackAuthenticator:
    def __init__(
        self,
        *,
        enabled: bool,
        key_path: str | Path,
        pairing_code_path: str | Path,
        timestamp_tolerance_seconds: int,
        logger: logging.Logger | None = None,
    ) -> None:
        self.enabled = enabled
        self.key_path = Path(key_path)
        self.pairing_code_path = Path(pairing_code_path)
        self.timestamp_tolerance_seconds = timestamp_tolerance_seconds
        self.logger = logger or logging.getLogger("kibitzer")
        self._secret: bytes | None = None
        self._pairing_code: str | None = None
        self._seen_nonces: dict[str, int] = {}
        self._failed_pairing_attempts: list[float] = []

    @property
    def paired(self) -> bool:
        return self._secret is not None

    def initialize(self) -> None:
        if not self.enabled:
            return
        self.key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.key_path.is_file():
            secret_hex = self.key_path.read_text(encoding="ascii").strip()
            if not _HEX_64.fullmatch(secret_hex):
                raise RuntimeError(f"invalid local API auth key: {self.key_path}")
            self._secret = bytes.fromhex(secret_hex)
            self._harden_file(self.key_path)
            return

        if self.pairing_code_path.is_file():
            pairing_code = self.pairing_code_path.read_text(encoding="ascii").strip()
            if not _HEX_64.fullmatch(pairing_code):
                raise RuntimeError(f"invalid local API pairing code: {self.pairing_code_path}")
        else:
            pairing_code = secrets.token_hex(32)
            self._create_private_file(self.pairing_code_path, pairing_code)
        self._pairing_code = pairing_code
        self.logger.warning(
            "Kibitzer extension pairing required. Enter this code in the extension popup: %s",
            pairing_code,
        )

    def status(self) -> dict[str, bool]:
        return {"enabled": self.enabled, "paired": self.paired}

    def pair(self, *, client_nonce: str, wrapped_secret: str, tag: str) -> str:
        if not self.enabled:
            raise PairingError("local API authentication is disabled")
        if self.paired:
            raise PairingError("local API is already paired")
        if not self._pairing_code:
            raise PairingError("pairing code is unavailable")
        if not _HEX_32.fullmatch(client_nonce):
            raise PairingError("invalid client nonce")
        if not _HEX_64.fullmatch(wrapped_secret) or not _HEX_64.fullmatch(tag):
            raise PairingError("invalid pairing payload")
        self._enforce_pairing_rate_limit()

        pair_key = hashlib.sha256(self._pairing_code.encode("ascii")).digest()
        canonical = f"{_PAIR_REQUEST_CONTEXT}\n{client_nonce}\n{wrapped_secret}".encode("ascii")
        expected_tag = hmac.new(pair_key, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_tag, tag):
            self._record_failed_pairing()
            raise PairingError("pairing proof did not match")

        mask = hmac.new(
            pair_key,
            f"{_PAIR_WRAP_CONTEXT}\n{client_nonce}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        secret = bytes(left ^ right for left, right in zip(bytes.fromhex(wrapped_secret), mask))
        if len(secret) != 32:
            raise PairingError("invalid wrapped secret")

        self._create_private_file(self.key_path, secret.hex())
        self._secret = secret
        self._pairing_code = None
        self.pairing_code_path.unlink(missing_ok=True)
        return hmac.new(
            secret,
            f"{_PAIR_RESPONSE_CONTEXT}\n{client_nonce}".encode("ascii"),
            hashlib.sha256,
        ).hexdigest()

    def verify_request(
        self,
        *,
        method: str,
        path_and_query: str,
        body: bytes,
        timestamp: str | None,
        nonce: str | None,
        signature: str | None,
    ) -> str | None:
        if not self.enabled or self._secret is None:
            return None
        if not timestamp or not nonce or not signature:
            return None
        if not timestamp.isdigit() or not _HEX_32.fullmatch(nonce) or not _HEX_64.fullmatch(signature):
            return None
        timestamp_value = int(timestamp)
        now = int(time.time())
        if abs(now - timestamp_value) > self.timestamp_tolerance_seconds:
            return None
        self._purge_seen_nonces(now)
        if nonce in self._seen_nonces:
            return None

        body_hash = hashlib.sha256(body).hexdigest()
        canonical = (
            f"{_REQUEST_CONTEXT}\n{timestamp}\n{nonce}\n{method.upper()}\n{path_and_query}\n{body_hash}"
        ).encode("utf-8")
        expected = hmac.new(self._secret, canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        self._seen_nonces[nonce] = timestamp_value
        return nonce

    def response_proof(self, *, request_nonce: str, status_code: int, body: bytes) -> str:
        if self._secret is None:
            raise RuntimeError("local API is not paired")
        body_hash = hashlib.sha256(body).hexdigest()
        canonical = f"{_RESPONSE_CONTEXT}\n{request_nonce}\n{status_code}\n{body_hash}".encode("ascii")
        return hmac.new(self._secret, canonical, hashlib.sha256).hexdigest()

    def _purge_seen_nonces(self, now: int) -> None:
        cutoff = now - self.timestamp_tolerance_seconds
        self._seen_nonces = {
            nonce: timestamp for nonce, timestamp in self._seen_nonces.items() if timestamp >= cutoff
        }

    def _enforce_pairing_rate_limit(self) -> None:
        cutoff = time.monotonic() - 60
        self._failed_pairing_attempts = [attempt for attempt in self._failed_pairing_attempts if attempt >= cutoff]
        if len(self._failed_pairing_attempts) >= 5:
            raise PairingError("too many failed pairing attempts")

    def _record_failed_pairing(self) -> None:
        self._failed_pairing_attempts.append(time.monotonic())

    @staticmethod
    def _create_private_file(path: Path, value: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise PairingError(f"security file already exists: {path}") from exc
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(value)
            handle.write("\n")

    @staticmethod
    def _harden_file(path: Path) -> None:
        if os.name != "nt":
            path.chmod(0o600)

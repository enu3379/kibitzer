from __future__ import annotations

from collections.abc import Iterable

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import LoopbackAuthenticator


_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_JSON_BODY_METHODS = {"POST", "PUT", "PATCH"}


class _RequestBodyTooLarge(Exception):
    pass


class LocalRequestSecurityMiddleware:
    """Enforce browser-origin and request-body rules for the loopback API."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_origins: Iterable[str],
        max_body_bytes: int,
    ) -> None:
        self.app = app
        self.allowed_origins = frozenset(origin.rstrip("/") for origin in allowed_origins)
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "/")

        if method in _MUTATING_METHODS:
            origin = headers.get("origin")
            if origin:
                if not self._origin_allowed(origin):
                    await self._reject(scope, receive, send, 403, "origin is not allowed")
                    return
            elif headers.get("sec-fetch-site", "").lower() == "cross-site":
                await self._reject(scope, receive, send, 403, "cross-site request is not allowed")
                return

            if path == "/auth/pair":
                normalized_origin = origin.rstrip("/") if origin else ""
                if (
                    not normalized_origin.startswith("chrome-extension://")
                    or normalized_origin not in self.allowed_origins
                ):
                    await self._reject(scope, receive, send, 403, "exact extension origin is required")
                    return

            if method in _JSON_BODY_METHODS:
                media_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if media_type != "application/json":
                    await self._reject(scope, receive, send, 415, "application/json is required")
                    return

        content_length = headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                await self._reject(scope, receive, send, 400, "invalid content-length")
                return
            if declared_length < 0:
                await self._reject(scope, receive, send, 400, "invalid content-length")
                return
            if declared_length > self.max_body_bytes:
                await self._reject(scope, receive, send, 413, "request body is too large")
                return

        received_bytes = 0
        response_started = False

        async def capped_receive() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_body_bytes:
                    raise _RequestBodyTooLarge
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, capped_receive, tracked_send)
        except _RequestBodyTooLarge:
            if response_started:
                raise
            await self._reject(scope, receive, send, 413, "request body is too large")

    def _origin_allowed(self, origin: str) -> bool:
        return origin.rstrip("/") in self.allowed_origins

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        detail: str,
    ) -> None:
        await JSONResponse({"detail": detail}, status_code=status_code)(scope, receive, send)


class AuthenticatedApiMiddleware:
    _EXEMPT_PATHS = {"/health", "/auth/status", "/auth/pair"}

    def __init__(self, app: ASGIApp, *, authenticator: LoopbackAuthenticator) -> None:
        self.app = app
        self.authenticator = authenticator

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or not self.authenticator.enabled
            or scope.get("method") == "OPTIONS"
            or scope.get("path") in self._EXEMPT_PATHS
        ):
            await self.app(scope, receive, send)
            return

        body = await self._read_body(receive)
        headers = Headers(scope=scope)
        raw_path = scope.get("raw_path") or str(scope.get("path") or "/").encode("ascii")
        query_string = scope.get("query_string") or b""
        path_and_query = raw_path.decode("ascii")
        if query_string:
            path_and_query += f"?{query_string.decode('ascii')}"
        request_nonce = self.authenticator.verify_request(
            method=str(scope.get("method") or "GET"),
            path_and_query=path_and_query,
            body=body,
            timestamp=headers.get("x-kibitzer-timestamp"),
            nonce=headers.get("x-kibitzer-nonce"),
            signature=headers.get("x-kibitzer-signature"),
        )
        if request_nonce is None:
            await JSONResponse({"detail": "authenticated pairing is required"}, status_code=401)(
                scope,
                self._replay_receive(body),
                send,
            )
            return

        captured: list[Message] = []

        async def capture(message: Message) -> None:
            captured.append(message)

        await self.app(scope, self._replay_receive(body), capture)
        response_start = next((message for message in captured if message["type"] == "http.response.start"), None)
        if response_start is None:
            for message in captured:
                await send(message)
            return

        response_body = b"".join(
            message.get("body", b"") for message in captured if message["type"] == "http.response.body"
        )
        proof = self.authenticator.response_proof(
            request_nonce=request_nonce,
            status_code=int(response_start["status"]),
            body=response_body,
        )
        response_start = {
            **response_start,
            "headers": [
                *(response_start.get("headers") or []),
                (b"x-kibitzer-response-proof", proof.encode("ascii")),
            ],
        }
        replaced_start = False
        for message in captured:
            if message["type"] == "http.response.start" and not replaced_start:
                await send(response_start)
                replaced_start = True
            else:
                await send(message)

    @staticmethod
    async def _read_body(receive: Receive) -> bytes:
        chunks: list[bytes] = []
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            chunks.append(message.get("body", b""))
            more_body = bool(message.get("more_body"))
        return b"".join(chunks)

    @staticmethod
    def _replay_receive(body: bytes) -> Receive:
        delivered = False

        async def receive() -> Message:
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}

        return receive

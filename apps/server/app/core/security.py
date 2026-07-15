from __future__ import annotations

from collections.abc import Sequence

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class OriginBoundaryMiddleware:
    def __init__(self, app: ASGIApp, allowed_extension_ids: Sequence[str]) -> None:
        self.app = app
        self.allowed_extension_origins = {
            f"chrome-extension://{extension_id}" for extension_id in allowed_extension_ids
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in MUTATING_METHODS:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin")
        if origin is None and headers.get("sec-fetch-site", "").lower() != "cross-site":
            await self.app(scope, receive, send)
            return
        if origin in self.allowed_extension_origins:
            await self.app(scope, receive, send)
            return

        host = headers.get("host", "")
        if origin == f"{scope.get('scheme', 'http')}://{host}":
            await self.app(scope, receive, send)
            return

        response = JSONResponse({"detail": "origin is not allowed"}, status_code=403)
        await response(scope, receive, send)

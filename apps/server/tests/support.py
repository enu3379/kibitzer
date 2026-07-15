from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient as FastAPITestClient


class TestClient(FastAPITestClient):
    """Test client whose Host header matches the production loopback allowlist."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("base_url", "http://127.0.0.1:8765")
        super().__init__(*args, **kwargs)

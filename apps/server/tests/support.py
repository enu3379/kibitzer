from typing import Any

from fastapi.testclient import TestClient as FastAPITestClient


class TestClient(FastAPITestClient):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("base_url", "http://127.0.0.1")
        super().__init__(*args, **kwargs)

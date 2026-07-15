from dataclasses import dataclass, field
from typing import Any

from fastapi.testclient import TestClient as FastAPITestClient

from apps.server.app.providers.judges.base import Tier2Decision


class TestClient(FastAPITestClient):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("base_url", "http://127.0.0.1")
        super().__init__(*args, **kwargs)


@dataclass
class AlwaysNotifyTier2Provider:
    message: str = "목표와 다른 페이지입니다."
    judge_payloads: list[dict[str, object]] = field(default_factory=list)
    writer_payloads: list[dict[str, object]] = field(default_factory=list)

    async def decide_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Decision:
        self.judge_payloads.append(payload)
        return Tier2Decision(decision="notify", reason_code="off_goal", basis="both")

    async def write_tier2_message(
        self,
        payload: dict[str, object],
        system_prompt: str,
    ) -> str:
        self.writer_payloads.append(payload)
        return self.message

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Literal

from ..config import AppConfig
from ..providers.embeddings.base import EmbeddingProvider
from ..providers.embeddings.factory import create_embedding_provider
from ..providers.judges.base import JudgeProvider
from ..providers.judges.factory import create_tier1_judge_provider, create_tier2_judge_provider
from ..storage.sqlite import SQLiteStore

RuntimeMode = Literal["idle", "active"]


class RuntimeResources:
    """Owns resources that should be cold while the daemon is idle."""

    def __init__(
        self,
        config: AppConfig,
        store: SQLiteStore,
        embedding_provider: EmbeddingProvider | None = None,
        tier1_provider: JudgeProvider | None = None,
        tier2_provider: JudgeProvider | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self._provided_embedding_provider = embedding_provider
        self._provided_tier1_provider = tier1_provider
        self._provided_tier2_provider = tier2_provider
        self._embedding_provider: EmbeddingProvider | None = None
        self._tier1_provider: JudgeProvider | None = None
        self._tier2_provider: JudgeProvider | None = None
        self._tier1_initialized = False
        self._tier2_initialized = False
        self._active_since: datetime | None = None
        self._degraded_recorded: set[int] = set()
        self._logger = logger or logging.getLogger("kibitzer")

    @property
    def mode(self) -> RuntimeMode:
        return "active" if self._active_since else "idle"

    @property
    def active_since(self) -> datetime | None:
        return self._active_since

    def status(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "active_since": self._active_since.isoformat() if self._active_since else None,
        }

    def activate(self, reason: str) -> None:
        if self._active_since is None:
            self._active_since = datetime.now(timezone.utc)
            self._logger.info("Kibitzer runtime activated: %s", reason)
        self._ensure_embedding_provider()
        self._ensure_tier1_provider()
        self._ensure_tier2_provider()

    def enter_idle(self, reason: str) -> None:
        if self._active_since is None:
            return
        self._embedding_provider = None
        self._tier1_provider = None
        self._tier2_provider = None
        self._tier1_initialized = False
        self._tier2_initialized = False
        self._active_since = None
        self._logger.info("Kibitzer runtime entered idle: %s", reason)

    def embedding_provider(self) -> EmbeddingProvider:
        self.activate("embedding_requested")
        assert self._embedding_provider is not None
        return self._embedding_provider

    def tier1_provider(self) -> JudgeProvider | None:
        self.activate("tier1_requested")
        return self._tier1_provider

    def tier2_provider(self) -> JudgeProvider | None:
        self.activate("tier2_requested")
        return self._tier2_provider

    def _ensure_embedding_provider(self) -> None:
        if self._embedding_provider is not None:
            return
        if self._provided_embedding_provider is not None:
            self._embedding_provider = self._provided_embedding_provider
            return
        self._embedding_provider = create_embedding_provider(self.config.embedding)

    def _ensure_tier1_provider(self) -> None:
        if self._tier1_initialized:
            return
        if self._provided_tier1_provider is not None:
            self._tier1_provider = self._provided_tier1_provider
        else:
            self._tier1_provider = create_tier1_judge_provider(self.config.tier1)
        self._tier1_initialized = True
        self._record_degraded_if_needed(1, self.config.tier1.enabled, self._tier1_provider)

    def _ensure_tier2_provider(self) -> None:
        if self._tier2_initialized:
            return
        if self._provided_tier2_provider is not None:
            self._tier2_provider = self._provided_tier2_provider
        else:
            self._tier2_provider = create_tier2_judge_provider(self.config.tier2)
        self._tier2_initialized = True
        self._record_degraded_if_needed(2, self.config.tier2.enabled, self._tier2_provider)

    def _record_degraded_if_needed(self, tier: int, enabled: bool, provider: JudgeProvider | None) -> None:
        if not enabled or provider is not None or tier in self._degraded_recorded:
            return
        self._logger.warning(
            "Tier %d is enabled but no provider credentials resolved; running without it",
            tier,
        )
        self.store.record_provider_degraded(tier=tier, reason="credentials_missing")
        self._degraded_recorded.add(tier)

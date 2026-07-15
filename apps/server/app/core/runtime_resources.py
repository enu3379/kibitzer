from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

import httpx

from ..config import AppConfig
from ..providers.embeddings.base import EmbeddingProvider
from ..providers.embeddings.factory import create_embedding_provider
from ..providers.judges.base import JudgeProvider
from ..providers.judges.factory import create_tier1_judge_provider, create_tier2_judge_provider
from ..storage.sqlite import SQLiteStore

RuntimeMode = Literal["idle", "active"]
ProviderCallResult = Literal["none", "success", "error"]
ProviderFailureReason = Literal[
    "timeout",
    "connection",
    "auth",
    "forbidden",
    "rate_limited",
    "server_error",
    "invalid_response",
    "other",
]


@dataclass
class ProviderCallStatus:
    last_result: ProviderCallResult = "none"
    reason: ProviderFailureReason | None = None
    checked_at: datetime | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {
            "last_result": self.last_result,
            "reason": self.reason,
            "checked_at": self.checked_at.isoformat() if self.checked_at else None,
        }


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
        self._provider_calls = {1: ProviderCallStatus(), 2: ProviderCallStatus()}
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

    def tier_status(self) -> dict[str, str]:
        """Judge-provider health for /health. Must not activate() — /health is
        polled from idle and waking the runtime would defeat the idle daemon."""
        return {
            "tier1": self._describe_tier(
                self.config.tier1.enabled,
                self._tier1_initialized,
                self._tier1_provider,
                lambda: create_tier1_judge_provider(self.config.tier1),
            ),
            "tier2": self._describe_tier(
                self.config.tier2.enabled,
                self._tier2_initialized,
                self._tier2_provider,
                lambda: create_tier2_judge_provider(self.config.tier2),
            ),
        }

    def provider_call_status(self) -> dict[str, dict[str, str | None]]:
        return {
            "tier1": self._provider_calls[1].as_dict(),
            "tier2": self._provider_calls[2].as_dict(),
        }

    def record_provider_call_success(self, tier: int) -> None:
        self._provider_calls[tier] = ProviderCallStatus(
            last_result="success",
            checked_at=datetime.now(timezone.utc),
        )

    def record_provider_call_failure(self, tier: int, exc: Exception) -> None:
        self._provider_calls[tier] = ProviderCallStatus(
            last_result="error",
            reason=_classify_provider_failure(exc),
            checked_at=datetime.now(timezone.utc),
        )

    def _describe_tier(
        self,
        enabled: bool,
        initialized: bool,
        provider: JudgeProvider | None,
        probe: Callable[[], JudgeProvider | None],
    ) -> str:
        if not enabled:
            return "disabled"
        if initialized:
            return "active" if provider is not None else "degraded"
        try:
            return "active" if probe() is not None else "degraded"
        except Exception:
            return "degraded"

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
            self._tier1_provider = self._create_judge_provider(
                1,
                lambda: create_tier1_judge_provider(self.config.tier1),
            )
        self._tier1_initialized = True
        self._record_degraded_if_needed(1, self.config.tier1.enabled, self._tier1_provider)

    def _ensure_tier2_provider(self) -> None:
        if self._tier2_initialized:
            return
        if self._provided_tier2_provider is not None:
            self._tier2_provider = self._provided_tier2_provider
        else:
            self._tier2_provider = self._create_judge_provider(
                2,
                lambda: create_tier2_judge_provider(self.config.tier2),
            )
        self._tier2_initialized = True
        self._record_degraded_if_needed(2, self.config.tier2.enabled, self._tier2_provider)

    def _create_judge_provider(
        self,
        tier: int,
        factory: Callable[[], JudgeProvider | None],
    ) -> JudgeProvider | None:
        try:
            return factory()
        except Exception as exc:
            self._logger.warning(
                "Tier %d provider configuration rejected (%s); running without it",
                tier,
                type(exc).__name__,
            )
            self.store.record_provider_degraded(tier=tier, reason="invalid_configuration")
            self._degraded_recorded.add(tier)
            return None

    def _record_degraded_if_needed(self, tier: int, enabled: bool, provider: JudgeProvider | None) -> None:
        if not enabled or provider is not None or tier in self._degraded_recorded:
            return
        self._logger.warning(
            "Tier %d is enabled but no provider credentials resolved; running without it",
            tier,
        )
        self.store.record_provider_degraded(tier=tier, reason="credentials_missing")
        self._degraded_recorded.add(tier)


def _classify_provider_failure(exc: Exception) -> ProviderFailureReason:
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.NetworkError):
        return "connection"
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        if status_code == 401:
            return "auth"
        if status_code == 403:
            return "forbidden"
        if status_code == 429:
            return "rate_limited"
        if 500 <= status_code < 600:
            return "server_error"
        return "other"
    if isinstance(exc, (ValueError, KeyError, IndexError, TypeError)):
        return "invalid_response"
    return "other"

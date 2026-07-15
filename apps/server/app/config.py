import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


CHROME_EXTENSION_ID_PATTERN = re.compile(r"^[a-p]{32}$")


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    db_path: str = "./data/kibitzer.sqlite3"


class SecurityConfig(BaseModel):
    allowed_extension_ids: list[str] = Field(default_factory=list)

    @field_validator("allowed_extension_ids")
    @classmethod
    def _validate_extension_ids(cls, values: list[str]) -> list[str]:
        for value in values:
            if not CHROME_EXTENSION_ID_PATTERN.fullmatch(value):
                raise ValueError("Chrome extension IDs must be 32 lowercase letters from a to p")
        return list(dict.fromkeys(values))


class EmbeddingConfig(BaseModel):
    provider: str = "hash_cpu"
    model: str = "token-hash-v1"
    tokenizer_path: str | None = None
    device: str = "cpu"
    forbid_gpu: bool = True
    batch_size: int = Field(default=8, ge=1, le=256)
    max_length: int = Field(default=128, ge=1, le=512)
    normalize: bool = True
    dimensions: int = 256


class RelevanceConfig(BaseModel):
    tau_ok: float = 0.15
    beta: float = 0.85
    anchor_window: int = Field(default=10, ge=0)
    exemplar_cap: int = 20
    # Anchor admission: a page whose OK came only through the anchor path
    # (goal-exemplar similarity below this) keeps its verdict but must not
    # join the anchor, or the reference frame drifts with the user.
    anchor_epsilon: float = 0.05


class GoalEnrichmentConfig(BaseModel):
    enabled: bool = True
    max_phrases: int = Field(default=8, ge=1, le=20)
    derived_tau: float = Field(default=0.25, ge=0.0, le=1.0)
    timeout_seconds: float = Field(default=20, gt=0)


class Tier1SendConfig(BaseModel):
    title: bool = True
    url_host: bool = True
    url_path: bool = False
    recent_titles: bool = True
    page_excerpt: bool = False


class Tier1Config(BaseModel):
    enabled: bool = True
    provider: str = "openai_compatible"
    base_url: str = "${TIER1_BASE_URL}"
    api_key_env: str = "TIER1_API_KEY"
    fallback_api_key_env: str | None = None
    # Optional rotation pool of env names; with >= 2 resolved keys each call
    # starts from the next key and the rest act as fallbacks.
    api_key_pool_envs: list[str] | None = None
    model: str = "cheap-classifier"
    timeout_seconds: float = 3
    recent_observations: int = 5
    experiment_models_file: str | None = None
    experiment_model_key: str | None = None
    send: Tier1SendConfig = Field(default_factory=Tier1SendConfig)


class Tier2Config(BaseModel):
    enabled: bool = True
    provider: str = "experiment"
    base_url: str = "${TIER2_BASE_URL}"
    api_key_env: str = "TIER2_API_KEY"
    fallback_api_key_env: str | None = "TIER2_FALLBACK_API_KEY"
    api_key_pool_envs: list[str] | None = None
    model: str = "qwen3.5:27b"
    timeout_seconds: float = 8
    recent_observations: int = 5
    excerpt_char_limit: int = 3000
    max_output_tokens: int = 512
    experiment_models_file: str | None = None
    experiment_model_key: str | None = None


class ControllerConfig(BaseModel):
    type: Literal["streak", "alignment"] = "streak"
    k: int = Field(default=3, ge=1, le=20)
    alignment_alpha: float = Field(default=0.85, ge=0.0, le=0.99)
    theta_low: float = Field(default=0.15, ge=0.0, le=1.0)
    theta_high: float = Field(default=0.3, ge=0.0, le=1.0)
    cooldown_seconds: int = 300
    snooze_seconds: int = 1800
    coldstart_observations: int = 5

    @model_validator(mode="after")
    def _validate_alignment_thresholds(self) -> "ControllerConfig":
        if self.theta_low >= self.theta_high:
            raise ValueError("theta_low must be lower than theta_high")
        return self


class DwellConfig(BaseModel):
    observation_seconds: int = Field(default=5, ge=1, le=300)
    tier2_seconds: int = Field(default=10, ge=1, le=300)


class TimeBudgetConfig(BaseModel):
    # Kept opt-in at the model layer so callers constructing AppConfig directly
    # retain the pre-D7 pipeline. configs/default.yaml enables the feature.
    enabled: bool = False
    total_fraction: float = Field(default=1 / 6, gt=0, le=1)
    min_total_seconds: int = Field(default=300, ge=1)
    fallback_total_seconds: int = Field(default=900, ge=1)
    per_page_seconds: int = Field(default=180, ge=1)
    heartbeat_seconds: int = Field(default=60, ge=30, le=60)
    max_heartbeat_gap_seconds: int = Field(default=90, ge=30)
    recent_excerpts: int = Field(default=5, ge=1, le=20)
    recent_excerpt_char_limit: int = Field(default=600, ge=1, le=3000)

    @model_validator(mode="after")
    def _validate_heartbeat_gap(self) -> "TimeBudgetConfig":
        if self.max_heartbeat_gap_seconds < self.heartbeat_seconds:
            raise ValueError("max_heartbeat_gap_seconds must be at least heartbeat_seconds")
        return self


class PrivacyConfig(BaseModel):
    sensitive_domains_file: str = "configs/sensitive_domains.yaml"
    strip_query: bool = True
    hash_url_path: bool = True


class VoiceConfig(BaseModel):
    enabled: bool = False
    voice: str = "Yuna"
    rate: int = 175


class QuietHoursConfig(BaseModel):
    enabled: bool = False
    start: str = "09:00"
    end: str = "18:00"


class CelebrationConfig(BaseModel):
    # Fractional minutes allowed (0.5 = 30s); the gate compares in seconds.
    min_drift_minutes: float = Field(default=3, ge=0)
    cooldown_seconds: int = Field(default=300, ge=0)


class BreakConfig(BaseModel):
    duration_seconds: int = Field(default=300, ge=0)


class DeliveryConfig(BaseModel):
    channel: str = "chrome_notification"
    persona: str = "dry_kibitzer"
    personas_file: str = "configs/personas.yaml"
    custom_personas_file: str = "~/.kibitzer/personas.yaml"
    max_sentences: int = 2
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    quiet_hours: QuietHoursConfig = Field(default_factory=QuietHoursConfig)


class AppConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    server: ServerConfig = Field(default_factory=ServerConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    relevance: RelevanceConfig = Field(default_factory=RelevanceConfig)
    goal_enrichment: GoalEnrichmentConfig = Field(default_factory=GoalEnrichmentConfig)
    tier1: Tier1Config = Field(default_factory=Tier1Config)
    tier2: Tier2Config = Field(default_factory=Tier2Config)
    controller: ControllerConfig = Field(default_factory=ControllerConfig)
    celebration: CelebrationConfig = Field(default_factory=CelebrationConfig)
    intentional_break: BreakConfig = Field(default_factory=BreakConfig, alias="break")
    dwell: DwellConfig = Field(default_factory=DwellConfig)
    time_budget: TimeBudgetConfig = Field(default_factory=TimeBudgetConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    delivery: DeliveryConfig = Field(default_factory=DeliveryConfig)
    raw: dict[str, Any] = Field(default_factory=dict)


def load_config(path: str | Path = "configs/default.yaml") -> AppConfig:
    load_dotenv(Path(".env"), override=False)
    config_path = Path(path)
    data = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    values = {
        k: v
        for k, v in (data or {}).items()
        if k
        in {
            "server",
            "security",
            "embedding",
            "relevance",
            "goal_enrichment",
            "tier1",
            "tier2",
            "controller",
            "celebration",
            "break",
            "dwell",
            "time_budget",
            "privacy",
            "delivery",
        }
    }
    extension_ids = os.environ.get("KIBITZER_EXTENSION_IDS")
    if extension_ids:
        security = dict(values.get("security") or {})
        security["allowed_extension_ids"] = [
            value.strip() for value in extension_ids.split(",") if value.strip()
        ]
        values["security"] = security

    return AppConfig(
        raw=data or {},
        **values,
    )

from pathlib import Path
from typing import Any, Literal

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field, model_validator


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8765
    db_path: str = "./data/kibitzer.sqlite3"


class EmbeddingConfig(BaseModel):
    provider: str = "hash_cpu"
    model: str = "token-hash-v1"
    device: str = "cpu"
    forbid_gpu: bool = True
    batch_size: int = 8
    normalize: bool = True
    dimensions: int = 256


class RelevanceConfig(BaseModel):
    tau_ok: float = 0.15
    beta: float = 0.85
    anchor_window: int = 10
    exemplar_cap: int = 20
    # Anchor admission: a page whose OK came only through the anchor path
    # (goal-exemplar similarity below this) keeps its verdict but must not
    # join the anchor, or the reference frame drifts with the user.
    anchor_epsilon: float = 0.05


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


class DeliveryConfig(BaseModel):
    channel: str = "chrome_notification"
    persona: str = "dry_kibitzer"
    personas_file: str = "configs/personas.yaml"
    max_sentences: int = 2
    voice: VoiceConfig = Field(default_factory=VoiceConfig)
    quiet_hours: QuietHoursConfig = Field(default_factory=QuietHoursConfig)


class AppConfig(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    relevance: RelevanceConfig = Field(default_factory=RelevanceConfig)
    tier1: Tier1Config = Field(default_factory=Tier1Config)
    tier2: Tier2Config = Field(default_factory=Tier2Config)
    controller: ControllerConfig = Field(default_factory=ControllerConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    delivery: DeliveryConfig = Field(default_factory=DeliveryConfig)
    raw: dict[str, Any] = Field(default_factory=dict)


def load_config(path: str | Path = "configs/default.yaml") -> AppConfig:
    load_dotenv(Path(".env"), override=False)
    config_path = Path(path)
    data = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    return AppConfig(
        raw=data or {},
        **{
            k: v
            for k, v in (data or {}).items()
            if k in {"server", "embedding", "relevance", "tier1", "tier2", "controller", "privacy", "delivery"}
        },
    )

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from ...config import Tier1Config, Tier2Config
from .base import JudgeProvider
from .openai_compatible import OpenAICompatibleJudgeProvider
from .ollama_chat import OllamaChatJudgeProvider


class JudgeProviderConfigError(ValueError):
    """Expected judge configuration failure with no secret-bearing value."""

    def __init__(self, field: str, error_type: str) -> None:
        self.field = field
        self.error_type = error_type
        super().__init__(
            f"invalid judge provider configuration: field={field}, error_type={error_type}"
        )


@dataclass(frozen=True)
class _ResolvedJudgeSettings:
    provider: str
    api_url: str
    api_key: str
    fallback_api_key: str | None
    api_keys: tuple[str, ...] | None
    model: str
    timeout_seconds: float
    max_output_tokens: int


def create_tier1_judge_provider(config: Tier1Config) -> JudgeProvider | None:
    if not config.enabled:
        return None

    if config.provider == "experiment":
        settings = _resolve_experiment_model_settings(
            models_file=config.experiment_models_file,
            model_key=config.experiment_model_key,
            api_key_env=config.api_key_env,
            fallback_api_key_env=config.fallback_api_key_env,
            api_key_pool_envs=config.api_key_pool_envs,
            default_model=config.model,
            timeout_seconds=config.timeout_seconds,
            max_output_tokens=128,
            # Tier 1 sits on the observation hot path: the config timeout caps
            # latency instead of the generation-oriented timeout in the models file.
            use_model_file_timeout=False,
        )
        return _build_judge(settings) if settings else None

    if config.provider != "openai_compatible":
        raise JudgeProviderConfigError(field="provider", error_type="ValueError")

    api_key = os.environ.get(config.api_key_env)
    base_url = _expand_env(config.base_url)
    if not api_key or not base_url:
        return None

    return OpenAICompatibleJudgeProvider(
        base_url=base_url,
        api_key=api_key,
        model=config.model,
        timeout_seconds=config.timeout_seconds,
    )


def create_tier2_judge_provider(config: Tier2Config) -> JudgeProvider | None:
    if not config.enabled:
        return None
    if config.provider not in {"experiment", "openai_compatible", "ollama", "ollama_chat"}:
        raise JudgeProviderConfigError(field="provider", error_type="ValueError")

    settings = _resolve_tier2_settings(config)
    if not settings:
        return None
    return _build_judge(settings)


def _build_judge(settings: _ResolvedJudgeSettings) -> JudgeProvider:
    if settings.provider == "openai_compatible":
        return OpenAICompatibleJudgeProvider(
            base_url=settings.api_url,
            api_key=settings.api_key,
            fallback_api_key=settings.fallback_api_key,
            api_keys=settings.api_keys,
            model=settings.model,
            timeout_seconds=settings.timeout_seconds,
            max_output_tokens=settings.max_output_tokens,
        )
    if settings.provider == "ollama_chat":
        return OllamaChatJudgeProvider(
            api_url=settings.api_url,
            api_key=settings.api_key,
            fallback_api_key=settings.fallback_api_key,
            api_keys=settings.api_keys,
            model=settings.model,
            timeout_seconds=settings.timeout_seconds,
            max_output_tokens=settings.max_output_tokens,
        )
    raise JudgeProviderConfigError(field="provider", error_type="ValueError")


def _expand_env(value: str) -> str | None:
    if value.startswith("${") and value.endswith("}"):
        return os.environ.get(value[2:-1])
    return value


def _resolve_tier2_settings(config: Tier2Config) -> _ResolvedJudgeSettings | None:
    if config.provider == "experiment":
        return _resolve_experiment_settings(config)
    return _resolve_direct_tier2_settings(config)


def _resolve_direct_tier2_settings(config: Tier2Config) -> _ResolvedJudgeSettings | None:
    api_url = _expand_env(config.base_url)
    api_key = os.environ.get(config.api_key_env)
    fallback_api_key = os.environ.get(config.fallback_api_key_env) if config.fallback_api_key_env else None
    if not api_url or not api_key:
        return None
    provider = "ollama_chat" if config.provider in {"ollama", "ollama_chat"} else config.provider
    return _ResolvedJudgeSettings(
        provider=provider,
        api_url=api_url,
        api_key=api_key,
        fallback_api_key=fallback_api_key,
        api_keys=None,
        model=config.model,
        timeout_seconds=config.timeout_seconds,
        max_output_tokens=config.max_output_tokens,
    )


def _resolve_experiment_settings(config: Tier2Config) -> _ResolvedJudgeSettings | None:
    return _resolve_experiment_model_settings(
        models_file=config.experiment_models_file,
        model_key=config.experiment_model_key,
        api_key_env=config.api_key_env,
        fallback_api_key_env=config.fallback_api_key_env,
        api_key_pool_envs=config.api_key_pool_envs,
        default_model=config.model,
        timeout_seconds=config.timeout_seconds,
        max_output_tokens=config.max_output_tokens,
        use_model_file_timeout=True,
    )


def _resolve_experiment_model_settings(
    models_file: str | None,
    model_key: str | None,
    api_key_env: str,
    fallback_api_key_env: str | None,
    default_model: str,
    timeout_seconds: float,
    max_output_tokens: int,
    use_model_file_timeout: bool,
    api_key_pool_envs: list[str] | None = None,
) -> _ResolvedJudgeSettings | None:
    if not models_file or not model_key:
        return None
    expanded = _expand_env(models_file) or models_file
    path = Path(expanded).expanduser()
    if not path.exists():
        return None

    try:
        contents = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise JudgeProviderConfigError(
            field="models_file",
            error_type=type(exc).__name__,
        ) from exc
    try:
        data = yaml.safe_load(contents) or {}
    except yaml.YAMLError as exc:
        raise JudgeProviderConfigError(
            field="models_file",
            error_type=type(exc).__name__,
        ) from exc
    if not isinstance(data, dict):
        raise JudgeProviderConfigError(field="models_file", error_type="TypeError")

    model_config = data.get(model_key)
    if model_config is None:
        return None
    if not isinstance(model_config, dict):
        raise JudgeProviderConfigError(field="model_entry", error_type="TypeError")

    api_url = str(model_config.get("api_url") or "")
    api_style = str(model_config.get("api_style") or "")
    model = str(model_config.get("model_name") or model_config.get("ollama_model") or default_model)
    api_key = os.environ.get(api_key_env) or str(model_config.get("api_key") or "")
    if not api_key and _is_local_url(api_url):
        # Local Ollama ignores authorization; a placeholder keeps the header valid.
        api_key = "local-ollama"
    fallback_api_key = (
        os.environ.get(fallback_api_key_env) if fallback_api_key_env else None
    ) or model_config.get("fallback_api_key")
    # Rotation pool: resolve each env name; only meaningful with >= 2 keys.
    pool = tuple(
        key for key in (os.environ.get(env) or "" for env in (api_key_pool_envs or [])) if key
    )
    api_keys = pool if len(pool) > 1 else None
    resolved_timeout = (
        _positive_float_setting(model_config, "timeout_sec", timeout_seconds)
        if use_model_file_timeout
        else timeout_seconds
    )
    resolved_max_tokens = _positive_int_setting(
        model_config,
        "max_output_tokens",
        max_output_tokens,
    )

    if not api_url or not api_key or not model:
        return None

    provider = _provider_from_experiment_style(api_style, api_url)
    return _ResolvedJudgeSettings(
        provider=provider,
        api_url=api_url,
        api_key=api_key,
        fallback_api_key=str(fallback_api_key) if fallback_api_key else None,
        api_keys=api_keys,
        model=model,
        timeout_seconds=resolved_timeout,
        max_output_tokens=resolved_max_tokens,
    )


def _is_local_url(url: str) -> bool:
    return "localhost" in url or "127.0.0.1" in url


def _provider_from_experiment_style(api_style: str, api_url: str) -> str:
    if api_style == "openai":
        return "openai_compatible"
    if api_style == "ollama" or (not api_style and "/api/chat" in api_url):
        return "ollama_chat"
    raise JudgeProviderConfigError(field="api_style", error_type="ValueError")


def _positive_float_setting(
    model_config: dict[str, object],
    field: str,
    default: float,
) -> float:
    value = model_config.get(field)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise JudgeProviderConfigError(field=field, error_type="TypeError")
    try:
        parsed = float(value)
    except ValueError as exc:
        raise JudgeProviderConfigError(field=field, error_type=type(exc).__name__) from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise JudgeProviderConfigError(field=field, error_type="ValueError")
    return parsed


def _positive_int_setting(
    model_config: dict[str, object],
    field: str,
    default: int,
) -> int:
    value = model_config.get(field)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise JudgeProviderConfigError(field=field, error_type="TypeError")
    try:
        parsed = int(value)
    except ValueError as exc:
        raise JudgeProviderConfigError(field=field, error_type=type(exc).__name__) from exc
    if parsed <= 0:
        raise JudgeProviderConfigError(field=field, error_type="ValueError")
    return parsed

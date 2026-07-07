from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from ...config import Tier1Config, Tier2Config
from .base import JudgeProvider
from .openai_compatible import OpenAICompatibleJudgeProvider
from .ollama_chat import OllamaChatJudgeProvider


@dataclass(frozen=True)
class _ResolvedJudgeSettings:
    provider: str
    api_url: str
    api_key: str
    fallback_api_key: str | None
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
            default_model=config.model,
            timeout_seconds=config.timeout_seconds,
            max_output_tokens=128,
            # Tier 1 sits on the observation hot path: the config timeout caps
            # latency instead of the generation-oriented timeout in the models file.
            use_model_file_timeout=False,
        )
        return _build_judge(settings) if settings else None

    if config.provider != "openai_compatible":
        raise ValueError(f"unsupported Tier 1 provider: {config.provider}")

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
            model=settings.model,
            timeout_seconds=settings.timeout_seconds,
            max_output_tokens=settings.max_output_tokens,
        )
    if settings.provider == "ollama_chat":
        return OllamaChatJudgeProvider(
            api_url=settings.api_url,
            api_key=settings.api_key,
            fallback_api_key=settings.fallback_api_key,
            model=settings.model,
            timeout_seconds=settings.timeout_seconds,
            max_output_tokens=settings.max_output_tokens,
        )
    raise ValueError(f"unsupported judge provider: {settings.provider}")


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
) -> _ResolvedJudgeSettings | None:
    if not models_file or not model_key:
        return None
    expanded = _expand_env(models_file) or models_file
    path = Path(expanded).expanduser()
    if not path.exists():
        return None

    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    model_config = data.get(model_key)
    if not isinstance(model_config, dict):
        return None

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
    resolved_timeout = (
        float(model_config.get("timeout_sec") or timeout_seconds)
        if use_model_file_timeout
        else timeout_seconds
    )
    resolved_max_tokens = int(model_config.get("max_output_tokens") or max_output_tokens)

    if not api_url or not api_key or not model:
        return None

    provider = _provider_from_experiment_style(api_style, api_url)
    return _ResolvedJudgeSettings(
        provider=provider,
        api_url=api_url,
        api_key=api_key,
        fallback_api_key=str(fallback_api_key) if fallback_api_key else None,
        model=model,
        timeout_seconds=resolved_timeout,
        max_output_tokens=resolved_max_tokens,
    )


def _is_local_url(url: str) -> bool:
    return "localhost" in url or "127.0.0.1" in url


def _provider_from_experiment_style(api_style: str, api_url: str) -> str:
    if api_style == "openai":
        return "openai_compatible"
    if api_style == "ollama" or "/api/chat" in api_url:
        return "ollama_chat"
    raise ValueError(f"unsupported experiment Tier 2 api_style: {api_style}")

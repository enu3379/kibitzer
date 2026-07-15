from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..providers.judges.base import TIER2_GUARD_SYSTEM_PROMPT
from ..storage.sqlite import GoalRecord, ObservationRecord


# Re-exported under the historical name; the canonical text lives in
# app/providers/judges/base.py so the persona composer and both judge providers
# share one injection-hardened source of truth.
TIER2_SYSTEM_PROMPT = TIER2_GUARD_SYSTEM_PROMPT


class PersonaVoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    voice: str | None = None
    rate: int | None = None


class Persona(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str = ""
    style_prompt: str = ""
    fallback_templates: list[str] = Field(default_factory=list)
    celebrate_templates: list[str] = Field(default_factory=list)
    voice: PersonaVoice | None = None
    max_sentences: int | None = None


class PersonaSet(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int = 1
    default: str | None = None
    personas: dict[str, Persona] = Field(default_factory=dict)


def load_personas(
    path: str | Path,
    user_path: str | Path | None = None,
    logger: logging.Logger | None = None,
) -> PersonaSet:
    base_data = _read_persona_yaml(path, missing_ok=False)
    user_data = _read_persona_yaml(user_path, missing_ok=True) if user_path else {}

    personas: dict[str, Persona] = {}
    personas.update(_validated_personas(base_data.get("personas"), str(Path(path).expanduser()), logger))
    if user_path:
        personas.update(_validated_personas(user_data.get("personas"), str(Path(user_path).expanduser()), logger))

    merged = {
        "version": user_data.get("version", base_data.get("version", 1)),
        "default": user_data.get("default", base_data.get("default")),
        "personas": personas,
    }
    return PersonaSet.model_validate(merged)


def compose_tier2_system_prompt(persona: Persona) -> str:
    style_prompt = persona.style_prompt.strip()
    if not style_prompt:
        return TIER2_SYSTEM_PROMPT
    return f"{TIER2_SYSTEM_PROMPT}\n\nPersona style layer:\n{style_prompt}"


def resolve_persona(
    persona_set: PersonaSet | None,
    settings: dict[str, Any],
    config_persona: str | None,
) -> Persona | None:
    if not persona_set:
        return None
    for key in (settings.get("persona"), config_persona, persona_set.default):
        if isinstance(key, str) and key in persona_set.personas:
            return persona_set.personas[key]
    return None


def format_persona_fallback(
    persona: Persona | None,
    goal: GoalRecord,
    observation: ObservationRecord,
    nag_count: int,
) -> str | None:
    if not persona or not persona.fallback_templates:
        return None
    template = persona.fallback_templates[max(0, nag_count - 1) % len(persona.fallback_templates)]
    values = {
        "goal": goal.raw_text,
        "title": observation.title or observation.url_host or "현재 페이지",
        "host": observation.url_host or "현재 페이지",
        "nag_count": str(nag_count),
    }
    try:
        return template.format(**values)
    except Exception:
        return None


def format_celebration_template(template: str, goal: GoalRecord, return_minutes: int) -> str | None:
    values = {
        "goal": goal.raw_text,
        "return_minutes": str(return_minutes),
    }
    try:
        return template.format(**values)
    except Exception:
        return None


def _read_persona_yaml(path: str | Path | None, missing_ok: bool) -> dict[str, Any]:
    if path is None:
        return {}
    expanded = Path(path).expanduser()
    if not expanded.exists():
        if missing_ok:
            return {}
        expanded.read_text(encoding="utf-8")
    data = yaml.safe_load(expanded.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def _validated_personas(
    raw_personas: object,
    source: str,
    logger: logging.Logger | None,
) -> dict[str, Persona]:
    if not isinstance(raw_personas, dict):
        return {}

    personas: dict[str, Persona] = {}
    for key, value in raw_personas.items():
        if not isinstance(key, str):
            _warn_invalid_persona(logger, source, str(key), "non-string key")
            continue
        try:
            personas[key] = Persona.model_validate(value)
        except ValidationError as exc:
            _warn_invalid_persona(logger, source, key, exc.errors()[0]["msg"] if exc.errors() else "invalid")
    return personas


def _warn_invalid_persona(logger: logging.Logger | None, source: str, key: str, reason: str) -> None:
    if logger:
        logger.warning("Skipping invalid persona %s from %s: %s", key, source, reason)

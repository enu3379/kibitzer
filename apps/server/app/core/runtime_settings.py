from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from ..config import AppConfig, ControllerConfig
from ..storage.sqlite import SQLiteStore

_HHMM_RE = re.compile(r"^(?P<hour>[01]\d|2[0-3]):(?P<minute>[0-5]\d)$")


def validate_hhmm(value: str) -> str:
    if not _HHMM_RE.match(value):
        raise ValueError("time must be HH:MM")
    return value


def runtime_settings(config: AppConfig, store: SQLiteStore) -> dict[str, Any]:
    stored = store.get_settings()
    cooldown = {
        "enabled": config.controller.cooldown_seconds > 0,
        "seconds": config.controller.cooldown_seconds,
    }
    stored_cooldown = stored.get("cooldown")
    if isinstance(stored_cooldown, dict):
        cooldown.update(
            {
                key: value
                for key, value in stored_cooldown.items()
                if key in {"enabled", "seconds"}
            }
        )

    quiet_hours = {
        "enabled": config.delivery.quiet_hours.enabled,
        "start": config.delivery.quiet_hours.start,
        "end": config.delivery.quiet_hours.end,
    }
    stored_quiet_hours = stored.get("quiet_hours")
    if isinstance(stored_quiet_hours, dict):
        quiet_hours.update(
            {
                key: value
                for key, value in stored_quiet_hours.items()
                if key in {"enabled", "start", "end"}
            }
        )

    return {
        "persona": stored.get("persona") if isinstance(stored.get("persona"), str) else config.delivery.persona,
        "voice_enabled": (
            bool(stored["voice_enabled"]) if "voice_enabled" in stored else config.delivery.voice.enabled
        ),
        "cooldown": cooldown,
        "quiet_hours": quiet_hours,
    }


def effective_controller_config(config: AppConfig, store: SQLiteStore) -> ControllerConfig:
    cooldown = runtime_settings(config, store)["cooldown"]
    enabled = bool(cooldown.get("enabled"))
    seconds = int(cooldown.get("seconds") or 0)
    return config.controller.model_copy(update={"cooldown_seconds": seconds if enabled else 0})


def quiet_hours_active(quiet_hours: dict[str, Any], now: datetime | None = None) -> bool:
    if not quiet_hours.get("enabled"):
        return False
    start = _minutes(validate_hhmm(str(quiet_hours.get("start", "09:00"))))
    end = _minutes(validate_hhmm(str(quiet_hours.get("end", "18:00"))))
    local_now = now.astimezone() if now else datetime.now().astimezone()
    current = local_now.hour * 60 + local_now.minute
    if start == end:
        return True
    if start < end:
        return start <= current < end
    return current >= start or current < end


def _minutes(value: str) -> int:
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)

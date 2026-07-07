from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..core.runtime_settings import runtime_settings, validate_hhmm
from ..storage.sqlite import SQLiteStore

router = APIRouter()


class QuietHoursResponse(BaseModel):
    enabled: bool
    start: str
    end: str


class CooldownResponse(BaseModel):
    enabled: bool
    seconds: int


class SettingsResponse(BaseModel):
    persona: str
    voice_enabled: bool
    cooldown: CooldownResponse
    quiet_hours: QuietHoursResponse


class QuietHoursPatch(BaseModel):
    enabled: bool | None = None
    start: str | None = None
    end: str | None = None

    @field_validator("start", "end")
    @classmethod
    def _validate_time(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            return validate_hhmm(value)
        except ValueError as exc:
            raise ValueError("time must be HH:MM") from exc


class CooldownPatch(BaseModel):
    enabled: bool | None = None
    seconds: int | None = Field(default=None, ge=0, le=86400)


class SettingsPatch(BaseModel):
    persona: str | None = None
    voice_enabled: bool | None = None
    cooldown: CooldownPatch | None = None
    quiet_hours: QuietHoursPatch | None = None


def _store(request: Request) -> SQLiteStore:
    return request.app.state.store


@router.get("/settings", response_model=SettingsResponse)
async def get_settings(request: Request) -> SettingsResponse:
    return SettingsResponse.model_validate(runtime_settings(request.app.state.config, _store(request)))


@router.put("/settings", response_model=SettingsResponse)
async def update_settings(request: Request, body: SettingsPatch) -> SettingsResponse:
    current = runtime_settings(request.app.state.config, _store(request))
    partial: dict[str, object] = {}

    if body.persona is not None:
        _validate_persona(request, body.persona)
        partial["persona"] = body.persona

    if body.voice_enabled is not None:
        partial["voice_enabled"] = body.voice_enabled

    if body.cooldown is not None:
        cooldown = dict(current["cooldown"])
        cooldown.update(body.cooldown.model_dump(exclude_none=True))
        cooldown["seconds"] = int(cooldown["seconds"])
        partial["cooldown"] = cooldown

    if body.quiet_hours is not None:
        quiet_hours = dict(current["quiet_hours"])
        quiet_hours.update(body.quiet_hours.model_dump(exclude_none=True))
        validate_hhmm(str(quiet_hours["start"]))
        validate_hhmm(str(quiet_hours["end"]))
        partial["quiet_hours"] = quiet_hours

    if partial:
        _store(request).update_settings(partial)

    return SettingsResponse.model_validate(runtime_settings(request.app.state.config, _store(request)))


def _validate_persona(request: Request, persona_key: str) -> None:
    persona_set = getattr(request.app.state, "persona_set", None)
    if not persona_set or persona_key not in persona_set.personas:
        raise HTTPException(status_code=400, detail="unknown persona")

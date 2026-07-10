from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl


class Source(StrEnum):
    BROWSER_NAV = "browser_nav"
    KEYSTROKE = "keystroke"
    AGENT_PROMPT = "agent_prompt"


class Verdict(StrEnum):
    OK = "OK"
    DRIFT = "DRIFT"


class BrowserNavPayload(BaseModel):
    url: HttpUrl
    title: str = ""
    tab_id: int | None = None


class RawObservation(BaseModel):
    source: Literal[Source.BROWSER_NAV]
    payload: BrowserNavPayload
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ObservationFeatures(BaseModel):
    emb: list[float] | None = None
    r0: float | None = None
    r_final: float | None = None
    tier_reached: int | None = None
    exemplar_score: float | None = None
    derived_score: float | None = None
    anchor_eligible: bool | None = None


class Observation(BaseModel):
    id: str
    ts: datetime
    session_id: str
    source: Source
    payload: dict[str, Any]
    features: ObservationFeatures = Field(default_factory=ObservationFeatures)
    verdict: Verdict | None = None
    tier1_reason: str | None = None


class Goal(BaseModel):
    raw_text: str
    keywords: list[str] = Field(default_factory=list)
    exemplars: list[list[float]] = Field(default_factory=list)
    provenance: Literal["declared"] = "declared"


class PipelineAction(StrEnum):
    NONE = "none"
    REQUEST_EXCERPT = "request_excerpt"
    NOTIFY = "notify"


class PipelineResultKind(StrEnum):
    INTERVENTION = "intervention"
    CELEBRATION = "celebration"


class PageInfo(BaseModel):
    host: str | None = None
    title: str | None = None


class PipelineResult(BaseModel):
    action: PipelineAction
    kind: PipelineResultKind = PipelineResultKind.INTERVENTION
    observation_id: str | None = None
    verdict: Verdict | None = None
    message: str | None = None
    intervention_id: str | None = None
    silent: bool = False
    page: PageInfo | None = None


class PageExcerpt(BaseModel):
    title: str = ""
    text: str = Field(default="", max_length=50000)


class FeedbackKind(StrEnum):
    RELATED = "related"
    ACCEPTED = "accepted"
    SNOOZE = "snooze"
    BREAK = "break"


class FeedbackRequest(BaseModel):
    kind: FeedbackKind
    intervention_id: str
    observation_id: str | None = None


class FeedbackResult(BaseModel):
    feedback_id: str
    kind: FeedbackKind
    duplicate: bool = False
    intervention_id: str
    observation_id: str | None = None
    intervention_status: str
    exemplar_count: int | None = None
    snoozed_until: datetime | None = None

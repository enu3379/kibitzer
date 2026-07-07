from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..core.runtime_settings import effective_controller_config
from ..storage.sqlite import NoActiveSessionError, SessionStatsRecord, SQLiteStore

router = APIRouter()


class SessionResponse(BaseModel):
    id: str
    created_at: str
    active: bool


class GoalRequest(BaseModel):
    raw_text: str = Field(min_length=1)
    keywords: list[str] = Field(default_factory=list)


class GoalResponse(BaseModel):
    session_id: str
    raw_text: str
    keywords: list[str]
    provenance: str
    updated_at: str


class CurrentSessionResponse(BaseModel):
    session: SessionResponse
    goal: GoalResponse | None = None


class PendingInterventionResponse(BaseModel):
    intervention_id: str
    observation_id: str | None = None
    message: str
    ts: str
    status: str


class SessionStateResponse(BaseModel):
    session_id: str
    has_goal: bool
    tracking: str
    controller_type: str
    streak: int
    streak_threshold: int
    window_size: int
    obs_count: int
    coldstart_observations: int
    snoozed_until: str | None = None
    cooldown_until: str | None = None
    pending_intervention: PendingInterventionResponse | None = None


class SnoozeRequest(BaseModel):
    duration_seconds: int | None = Field(default=None, ge=0)


class SnoozeResponse(BaseModel):
    session_id: str
    snoozed_until: str


class SessionStatsResponse(BaseModel):
    session_id: str
    started_at: str
    ended_at: str | None = None
    duration_seconds: int
    observations: int
    ok: int
    drift: int
    unjudged: int
    related_ratio: float | None = None
    interventions: int
    interventions_accepted: int
    top_drift_host: str | None = None
    top_drift_count: int


def _store(request: Request) -> SQLiteStore:
    return request.app.state.store


async def _embed_goal(request: Request, text: str) -> list[float]:
    vectors = await request.app.state.embedding_provider.embed([text])
    return vectors[0]


@router.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(request: Request) -> SessionResponse:
    session = _store(request).create_session()
    return SessionResponse(
        id=session.id,
        created_at=session.created_at.isoformat(),
        active=session.active,
    )


@router.get("/sessions/current", response_model=CurrentSessionResponse)
async def get_current_session(request: Request) -> CurrentSessionResponse:
    current = _store(request).get_current_session()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")
    goal = None
    if current.goal:
        goal = GoalResponse(
            session_id=current.goal.session_id,
            raw_text=current.goal.raw_text,
            keywords=current.goal.keywords,
            provenance=current.goal.provenance,
            updated_at=current.goal.updated_at.isoformat(),
        )
    return CurrentSessionResponse(
        session=SessionResponse(
            id=current.session.id,
            created_at=current.session.created_at.isoformat(),
            active=current.session.active,
        ),
        goal=goal,
    )


@router.get("/sessions/current/state", response_model=SessionStateResponse)
async def get_current_state(request: Request) -> SessionStateResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")

    controller_config = effective_controller_config(request.app.state.config, store)
    state = store.get_controller_state(current.session.id)
    now = datetime.now(timezone.utc)
    drift_score = state.streak
    if controller_config.type == "window":
        drift_score = sum(
            1
            for verdict in store.recent_verdicts(
                current.session.id,
                controller_config.window_size,
                after=state.last_intervention_ts,
            )
            if verdict == "DRIFT"
        )

    cooldown_until = None
    if state.last_intervention_ts:
        candidate = state.last_intervention_ts + timedelta(seconds=controller_config.cooldown_seconds)
        if candidate > now:
            cooldown_until = candidate

    snoozed = state.snoozed_until is not None and state.snoozed_until > now
    if snoozed:
        tracking = "snoozed"
    elif state.obs_count < controller_config.coldstart_observations:
        tracking = "coldstart"
    elif cooldown_until:
        tracking = "cooldown"
    else:
        tracking = "tracking"

    pending = store.latest_unhandled_intervention(current.session.id)
    return SessionStateResponse(
        session_id=current.session.id,
        has_goal=current.goal is not None,
        tracking=tracking,
        controller_type=controller_config.type,
        streak=drift_score,
        streak_threshold=controller_config.k,
        window_size=controller_config.window_size,
        obs_count=state.obs_count,
        coldstart_observations=controller_config.coldstart_observations,
        snoozed_until=state.snoozed_until.isoformat() if snoozed else None,
        cooldown_until=cooldown_until.isoformat() if cooldown_until else None,
        pending_intervention=PendingInterventionResponse(
            intervention_id=pending.id,
            observation_id=pending.observation_id,
            message=pending.message,
            ts=pending.ts.isoformat(),
            status=pending.status,
        )
        if pending
        else None,
    )


@router.get("/sessions/current/stats", response_model=SessionStatsResponse)
async def get_current_stats(request: Request) -> SessionStatsResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")
    return _stats_response(store.session_stats(current.session.id))


@router.post("/sessions/current/snooze", response_model=SnoozeResponse)
async def snooze_current_session(request: Request, body: SnoozeRequest | None = None) -> SnoozeResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")

    duration = (
        body.duration_seconds
        if body is not None and body.duration_seconds is not None
        else request.app.state.config.controller.snooze_seconds
    )
    session_id = current.session.id
    state = store.get_controller_state(session_id)
    now = datetime.now(timezone.utc)
    snoozed_until = now + timedelta(seconds=duration)
    store.save_controller_state(
        session_id=session_id,
        streak=state.streak,
        obs_count=state.obs_count,
        last_intervention_ts=state.last_intervention_ts,
        snoozed_until=snoozed_until,
        ts=now,
    )
    store.record_session_snoozed(session_id, snoozed_until, source="api", ts=now)
    return SnoozeResponse(session_id=session_id, snoozed_until=snoozed_until.isoformat())


@router.post("/sessions/current/end", response_model=SessionStatsResponse)
async def end_current_session(request: Request) -> SessionStatsResponse:
    store = _store(request)
    try:
        session = store.end_current_session()
    except NoActiveSessionError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _stats_response(store.session_stats(session.id))


def _stats_response(stats: SessionStatsRecord) -> SessionStatsResponse:
    return SessionStatsResponse(
        session_id=stats.session_id,
        started_at=stats.started_at.isoformat(),
        ended_at=stats.ended_at.isoformat() if stats.ended_at else None,
        duration_seconds=stats.duration_seconds,
        observations=stats.observations,
        ok=stats.ok,
        drift=stats.drift,
        unjudged=stats.unjudged,
        related_ratio=stats.related_ratio,
        interventions=stats.interventions,
        interventions_accepted=stats.interventions_accepted,
        top_drift_host=stats.top_drift_host,
        top_drift_count=stats.top_drift_count,
    )


@router.post("/sessions/current/goal", response_model=GoalResponse)
async def set_current_goal(request: Request, body: GoalRequest) -> GoalResponse:
    try:
        exemplar = await _embed_goal(request, body.raw_text)
        goal = _store(request).set_current_goal(body.raw_text, body.keywords, exemplar)
    except NoActiveSessionError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return GoalResponse(
        session_id=goal.session_id,
        raw_text=goal.raw_text,
        keywords=goal.keywords,
        provenance=goal.provenance,
        updated_at=goal.updated_at.isoformat(),
    )

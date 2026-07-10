import asyncio
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from ..core.goal_enrichment import enrich_goal_derived_exemplars
from ..core.runtime_settings import effective_controller_config
from ..core.runtime_resources import RuntimeResources
from ..storage.sqlite import NoActiveSessionError, SessionReportRecord, SessionStatsRecord, SQLiteStore

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
    tier1_reason: str | None = None


class SessionStateResponse(BaseModel):
    session_id: str
    has_goal: bool
    tracking: str
    controller_type: str
    streak: int
    streak_threshold: int
    alignment_score: float | None = None
    theta_low: float | None = None
    theta_high: float | None = None
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


class HourBucketResponse(BaseModel):
    hour: str
    observations: int
    ok: int
    drift: int
    related_ratio: float | None = None


class DriftHostResponse(BaseModel):
    host: str
    count: int


class OkStretchResponse(BaseModel):
    start: str
    end: str
    minutes: int


class JudgmentReasonResponse(BaseModel):
    observation_id: str
    ts: str
    verdict: str | None = None
    url_host: str | None = None
    title: str | None = None
    tier_reached: int | None = None
    tier1_reason: str | None = None


class SessionReportResponse(BaseModel):
    scope: str
    session_id: str | None = None
    date: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    duration_seconds: int
    observations: int
    ok: int
    drift: int
    unjudged: int
    related_ratio: float | None = None
    hourly_related_ratio: list[HourBucketResponse]
    top_drift_hosts: list[DriftHostResponse]
    longest_ok_stretch: OkStretchResponse | None = None
    intervention_status_counts: dict[str, int]
    feedback_counts: dict[str, int]
    judgments: list[JudgmentReasonResponse]


def _store(request: Request) -> SQLiteStore:
    return request.app.state.store


def _runtime(request: Request) -> RuntimeResources:
    return request.app.state.runtime


async def _embed_goal(request: Request, text: str) -> list[float]:
    vectors = await _runtime(request).embedding_provider().embed([text])
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
    drift_threshold = controller_config.k
    alignment_score = None
    theta_low = None
    theta_high = None
    if controller_config.type == "alignment":
        drift_threshold = 1
        alignment_score = state.alignment_score
        theta_low = controller_config.theta_low
        theta_high = controller_config.theta_high

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
        streak_threshold=drift_threshold,
        alignment_score=alignment_score,
        theta_low=theta_low,
        theta_high=theta_high,
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
            tier1_reason=pending.tier1_reason,
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


@router.get("/sessions/current/report", response_model=SessionReportResponse)
async def get_current_report(request: Request) -> SessionReportResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")
    return _report_response(store.session_report(current.session.id))


@router.get("/reports/daily", response_model=SessionReportResponse)
async def get_daily_report(request: Request, date: date) -> SessionReportResponse:
    return _report_response(_store(request).daily_report(date))


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
        alignment_score=state.alignment_score,
        drift_latched=state.drift_latched,
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
    _runtime(request).enter_idle("session_end")
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


def _report_response(report: SessionReportRecord) -> SessionReportResponse:
    return SessionReportResponse(
        scope=report.scope,
        session_id=report.session_id,
        date=report.date,
        started_at=report.started_at.isoformat() if report.started_at else None,
        ended_at=report.ended_at.isoformat() if report.ended_at else None,
        duration_seconds=report.duration_seconds,
        observations=report.observations,
        ok=report.ok,
        drift=report.drift,
        unjudged=report.unjudged,
        related_ratio=report.related_ratio,
        hourly_related_ratio=[
            HourBucketResponse(
                hour=bucket.hour,
                observations=bucket.observations,
                ok=bucket.ok,
                drift=bucket.drift,
                related_ratio=bucket.related_ratio,
            )
            for bucket in report.hourly_related_ratio
        ],
        top_drift_hosts=[
            DriftHostResponse(host=host.host, count=host.count)
            for host in report.top_drift_hosts
        ],
        longest_ok_stretch=(
            OkStretchResponse(
                start=report.longest_ok_stretch.start.isoformat(),
                end=report.longest_ok_stretch.end.isoformat(),
                minutes=report.longest_ok_stretch.minutes,
            )
            if report.longest_ok_stretch
            else None
        ),
        intervention_status_counts=report.intervention_status_counts,
        feedback_counts=report.feedback_counts,
        judgments=[
            JudgmentReasonResponse(
                observation_id=judgment.observation_id,
                ts=judgment.ts.isoformat(),
                verdict=judgment.verdict,
                url_host=judgment.url_host,
                title=judgment.title,
                tier_reached=judgment.tier_reached,
                tier1_reason=judgment.tier1_reason,
            )
            for judgment in report.judgments
        ],
    )


@router.post("/sessions/current/goal", response_model=GoalResponse)
async def set_current_goal(request: Request, body: GoalRequest) -> GoalResponse:
    store = _store(request)
    if not store.get_current_session():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no active session")
    try:
        exemplar = await _embed_goal(request, body.raw_text)
        goal = store.set_current_goal(body.raw_text, body.keywords, exemplar)
        _schedule_goal_enrichment(request, goal.session_id, goal.raw_text)
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


def _schedule_goal_enrichment(request: Request, session_id: str, goal_text: str) -> None:
    config = request.app.state.config.goal_enrichment
    if not config.enabled:
        return

    async def _run() -> None:
        store = _store(request)
        try:
            runtime = _runtime(request)
            await enrich_goal_derived_exemplars(
                session_id=session_id,
                goal_text=goal_text,
                provider=runtime.tier1_provider(),
                embedding_provider=runtime.embedding_provider(),
                store=store,
                config=config,
            )
        except Exception as exc:
            store.record_goal_enrichment_failed(session_id, type(exc).__name__)

    asyncio.create_task(_run())

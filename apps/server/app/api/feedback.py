from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..core.page_labels import apply_page_label_override
from ..core.runtime_settings import effective_controller_config
from ..schemas import FeedbackKind, FeedbackRequest, FeedbackResult
from ..storage.sqlite import SQLiteStore

router = APIRouter()


class DeliveryReport(BaseModel):
    ok: bool
    error: str | None = None


class DeliveryReportResult(BaseModel):
    intervention_id: str
    status: str


@router.post("/interventions/{intervention_id}/delivery", response_model=DeliveryReportResult)
async def report_delivery(
    request: Request,
    intervention_id: str,
    body: DeliveryReport,
) -> DeliveryReportResult:
    store = _store(request)
    intervention = store.get_intervention(intervention_id)
    if not intervention:
        raise HTTPException(status_code=404, detail="intervention not found")

    store.record_delivery_report(intervention.session_id, intervention.id, body.ok, body.error)
    status = "delivered" if body.ok else "delivery_failed"
    if intervention.status == "pending":
        store.update_intervention_status(intervention.id, status)
    else:
        status = intervention.status
    return DeliveryReportResult(intervention_id=intervention.id, status=status)


def _store(request: Request) -> SQLiteStore:
    return request.app.state.store


@router.post("/feedback", response_model=FeedbackResult)
async def submit_feedback(request: Request, feedback: FeedbackRequest) -> FeedbackResult:
    store = _store(request)
    intervention = store.get_intervention(feedback.intervention_id)
    if not intervention:
        raise HTTPException(status_code=404, detail="intervention not found")

    observation_id = feedback.observation_id or intervention.observation_id
    if not observation_id:
        raise HTTPException(status_code=400, detail="feedback requires an observation")
    if feedback.observation_id and intervention.observation_id and feedback.observation_id != intervention.observation_id:
        raise HTTPException(status_code=400, detail="observation does not match intervention")

    observation = store.get_observation(observation_id)
    if not observation or observation.session_id != intervention.session_id:
        raise HTTPException(status_code=404, detail="observation not found")

    if feedback.kind == FeedbackKind.RELATED:
        emb = observation.features.get("emb")
        if not isinstance(emb, list) or not emb:
            raise HTTPException(status_code=400, detail="observation has no embedding")

    feedback_id, created = store.record_feedback_once(
        session_id=intervention.session_id,
        kind=feedback.kind.value,
        intervention_id=intervention.id,
        observation_id=observation.id,
    )

    exemplar_count: int | None = None
    exemplar_added = False
    verdict = None
    snoozed_until = None
    status = intervention.status

    if feedback.kind == FeedbackKind.RELATED:
        _page_label, exemplar_count, verdict, exemplar_added = apply_page_label_override(
            store,
            effective_controller_config(request.app.state.config, store),
            observation,
            label="related",
            exemplar_cap=request.app.state.config.relevance.exemplar_cap,
        )
        refreshed = store.get_intervention(intervention.id)
        status = refreshed.status if refreshed else intervention.status
        if status != "related":
            store.update_intervention_status(intervention.id, "related")
            status = "related"
    elif created:
        if feedback.kind == FeedbackKind.ACCEPTED:
            status = "accepted"
            store.update_intervention_status(intervention.id, status)
        elif feedback.kind == FeedbackKind.SNOOZE:
            snoozed_until = _apply_snooze(request, intervention.session_id)
            status = "snoozed"
            store.update_intervention_status(intervention.id, status)
        elif feedback.kind == FeedbackKind.BREAK:
            snoozed_until = _apply_break(request, intervention.session_id)
            status = "break"
            store.update_intervention_status(intervention.id, status)
    else:
        if feedback.kind in {FeedbackKind.SNOOZE, FeedbackKind.BREAK}:
            snoozed_until = store.get_controller_state(intervention.session_id).snoozed_until
        refreshed = store.get_intervention(intervention.id)
        status = refreshed.status if refreshed else status

    return FeedbackResult(
        feedback_id=feedback_id,
        kind=feedback.kind,
        duplicate=not created,
        intervention_id=intervention.id,
        observation_id=observation.id,
        intervention_status=status,
        verdict=verdict,
        exemplar_count=exemplar_count,
        exemplar_added=exemplar_added,
        snoozed_until=snoozed_until,
    )


def _apply_snooze(request: Request, session_id: str) -> datetime:
    return _apply_silence(
        request,
        session_id,
        duration_seconds=request.app.state.config.controller.snooze_seconds,
        source="feedback",
    )


def _apply_break(request: Request, session_id: str) -> datetime:
    return _apply_silence(
        request,
        session_id,
        duration_seconds=request.app.state.config.intentional_break.duration_seconds,
        source="break",
    )


def _apply_silence(request: Request, session_id: str, duration_seconds: int, source: str) -> datetime:
    store = _store(request)
    state = store.get_controller_state(session_id)
    now = datetime.now(timezone.utc)
    snoozed_until = now + timedelta(seconds=duration_seconds)
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
    store.record_session_snoozed(session_id, snoozed_until, source=source, ts=now)
    return snoozed_until

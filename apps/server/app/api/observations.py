from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import ceil
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import ControllerConfig
from ..core.controller_flow import (
    controller_state_after_intervention,
    time_review_is_eligible,
)
from ..core.delivery import clamp_notification_message
from ..core.ingest import ingest_browser_nav as ingest_browser_nav_core
from ..core.ingest import observation_page_info
from ..core.personas import (
    Persona,
    compose_tier2_judge_system_prompt,
    compose_tier2_writer_system_prompt,
    format_persona_fallback,
    resolve_persona,
)
from ..core.page_labels import apply_page_label_override
from ..core.relevance import DRIFT_RELEVANCE, RELATED_RELEVANCE
from ..core.runtime_resources import RuntimeResources
from ..core.runtime_settings import effective_controller_config, quiet_hours_active, runtime_settings
from ..core.tier2_payload import (
    build_tier2_message_payload,
    build_tier2_review_payload,
    fallback_drift_message,
)
from ..core.time_budget import (
    TIER2_REVIEW_LEAD_SECONDS,
    TimeBudgetThresholds,
    mode_clock_seconds,
    next_review_boundary,
    seconds_until_review_due,
    thresholds_for_budget,
)
from ..core.voice import speak
from ..providers.judges.base import ProviderResponseError, Tier2Decision
from ..schemas import PageExcerpt, PipelineAction, PipelineResult, RawObservation, Verdict
from ..storage.sqlite import (
    CurrentSessionRecord,
    DriftClockStateRecord,
    IdempotencyConflictError,
    ObservationRecord,
    SQLiteStore,
    effective_observation_verdict,
)

router = APIRouter()
logger = logging.getLogger("kibitzer")

class LatestObservationFeatures(BaseModel):
    r0: float | None = None
    r_override: float | None = None
    exemplar_score: float | None = None
    derived_score: float | None = None
    anchor_eligible: bool | None = None
    tier_reached: int | None = None


class LatestObservationResponse(BaseModel):
    observation_id: str
    title: str | None = None
    url_host: str | None = None
    verdict: str | None = None
    features: LatestObservationFeatures
    tier1_reason: str | None = None
    # Display context for the popup page card: the Tier-0 threshold the r0
    # feature was judged against, and the user's current page label (if any).
    tau_ok: float | None = None
    label: Literal["related", "drift"] | None = None


class CurrentPageStateResponse(BaseModel):
    state: Literal["unobserved", "processing", "judged"]
    stage: Literal["tier0", "tier1"] | None = None
    observation_id: str | None = None
    title: str | None = None
    url_host: str | None = None
    observation: LatestObservationResponse | None = None


class PageLabelRequest(BaseModel):
    label: Literal["related", "drift"]


class PageLabelResponse(BaseModel):
    label_id: str
    observation_id: str
    label: Literal["related", "drift"]
    verdict: Literal["OK", "DRIFT"] | None = None
    exemplar_count: int | None = None


class ContentCaptureResponse(BaseModel):
    observation_id: str
    stored: bool
    char_count: int


class PresenceRequest(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    kind: Literal["active", "heartbeat", "inactive"]
    tab_id: int
    url_path_hash: str = Field(min_length=1, max_length=128)


def _store(request: Request) -> SQLiteStore:
    return request.app.state.store


def _runtime(request: Request) -> RuntimeResources:
    return request.app.state.runtime


@router.get("/observations/page-state", response_model=CurrentPageStateResponse)
async def current_page_state(
    request: Request,
    tab_id: int,
    url_host: str,
    url_path_hash: str,
) -> CurrentPageStateResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current or not current.goal:
        return CurrentPageStateResponse(state="unobserved")

    processing = store.observation_processing_state_for_page(
        current.session.id,
        current.goal.goal_revision,
        tab_id,
        url_host,
        url_path_hash,
    )
    if processing:
        return CurrentPageStateResponse(
            state="processing",
            stage=processing.stage,
            observation_id=processing.observation_id,
            title=processing.title,
            url_host=processing.url_host,
        )

    observation = store.latest_observation_for_tab(
        current.session.id,
        tab_id,
        current.goal.goal_revision,
    )
    if (
        not observation
        or observation.url_host != url_host
        or observation.url_path_hash != url_path_hash
    ):
        return CurrentPageStateResponse(state="unobserved")

    return CurrentPageStateResponse(
        state="judged",
        observation_id=observation.id,
        title=observation.title,
        url_host=observation.url_host,
        observation=_latest_observation_response(
            observation,
            tau_ok=float(runtime_settings(request.app.state.config, store)["relevance"]["tau_ok"]),
            label=store.page_label_for_observation(observation.id),
        ),
    )


@router.get("/observations/latest", response_model=LatestObservationResponse)
async def latest_observation_for_tab(
    request: Request,
    tab_id: int,
    url_host: str,
    url_path_hash: str,
) -> LatestObservationResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=404, detail="no active session")
    observation = store.latest_observation_for_tab(
        current.session.id,
        tab_id,
        current.goal.goal_revision if current.goal else None,
    )
    # A Chrome tab id survives navigation. Require the popup's privacy-safe
    # current-page identity so a pre-dwell navigation cannot expose or label
    # the previous page's observation as the page currently behind the popup.
    if (
        not observation
        or observation.url_host != url_host
        or observation.url_path_hash != url_path_hash
    ):
        raise HTTPException(status_code=404, detail="observation not found")
    return _latest_observation_response(
        observation,
        tau_ok=float(runtime_settings(request.app.state.config, store)["relevance"]["tau_ok"]),
        label=store.page_label_for_observation(observation.id),
    )


@router.post("/observations/{observation_id}/label", response_model=PageLabelResponse)
async def label_observation(
    request: Request,
    observation_id: str,
    body: PageLabelRequest,
) -> PageLabelResponse:
    store = _store(request)
    current = store.get_current_session()
    if not current:
        raise HTTPException(status_code=404, detail="no active session")
    observation = store.get_observation(observation_id)
    if not observation or observation.session_id != current.session.id:
        raise HTTPException(status_code=404, detail="observation not found")

    if body.label == "related":
        emb = observation.features.get("emb")
        if not isinstance(emb, list) or not emb:
            raise HTTPException(status_code=400, detail="observation has no embedding")

    page_label, exemplar_count, verdict = apply_page_label_override(
        store,
        effective_controller_config(request.app.state.config, store),
        observation,
        label=body.label,
        exemplar_cap=request.app.state.config.relevance.exemplar_cap,
    )
    if verdict != Verdict.DRIFT.value:
        store.release_d7_review(
            observation.session_id,
            observation.id,
            "page_label_related",
        )

    return PageLabelResponse(
        label_id=page_label.id,
        observation_id=page_label.observation_id,
        label=body.label,
        verdict=verdict,
        exemplar_count=exemplar_count,
    )


@router.post("/observations/browser-nav", response_model=PipelineResult)
async def ingest_browser_nav(request: Request, raw: RawObservation) -> PipelineResult:
    store = _store(request)
    idempotency_key = raw.idempotency_key
    if idempotency_key is None:
        return await _ingest_browser_nav_serialized(request, raw)

    request_fingerprint = _browser_nav_request_fingerprint(raw)
    try:
        request_record, claimed = store.claim_observation_request(
            idempotency_key,
            request_fingerprint,
        )
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not claimed:
        if request_record.result is not None:
            return PipelineResult.model_validate(request_record.result)
        raise HTTPException(
            status_code=409,
            detail="browser-nav request is still processing",
            headers={"Retry-After": "1"},
        )

    try:
        result = await _ingest_browser_nav_serialized(request, raw)
    except Exception:
        store.release_observation_request(idempotency_key, request_fingerprint)
        raise

    completed = store.complete_observation_request(
        idempotency_key,
        request_fingerprint,
        result.model_dump(mode="json"),
    )
    if completed.result is None:
        raise RuntimeError("completed browser-nav request has no stored result")
    return PipelineResult.model_validate(completed.result)


async def _ingest_browser_nav_serialized(
    request: Request,
    raw: RawObservation,
) -> PipelineResult:
    async with request.app.state.browser_nav_lock:
        current = _store(request).get_current_session()
        return await _ingest_browser_nav_once(request, raw, current)


async def _ingest_browser_nav_once(
    request: Request,
    raw: RawObservation,
    current: CurrentSessionRecord | None,
) -> PipelineResult:
    return await ingest_browser_nav_core(
        raw,
        current,
        config=request.app.state.config,
        store=request.app.state.store,
        runtime=request.app.state.runtime,
        sensitive_domain_rules=request.app.state.sensitive_domain_rules,
        persona_set=getattr(request.app.state, "persona_set", None),
    )


def _browser_nav_request_fingerprint(raw: RawObservation) -> str:
    request = raw.model_dump(mode="json", exclude={"idempotency_key", "ts"})
    canonical = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _latest_observation_response(
    observation: ObservationRecord,
    tau_ok: float | None = None,
    label: str | None = None,
) -> LatestObservationResponse:
    features = observation.features
    return LatestObservationResponse(
        observation_id=observation.id,
        title=observation.title,
        url_host=observation.url_host,
        verdict=effective_observation_verdict(observation.verdict, label),
        features=LatestObservationFeatures(
            r0=features.get("r0"),
            r_override=(
                RELATED_RELEVANCE
                if label == "related"
                else DRIFT_RELEVANCE if label == "drift" else None
            ),
            exemplar_score=features.get("exemplar_score"),
            derived_score=features.get("derived_score"),
            anchor_eligible=features.get("anchor_eligible"),
            tier_reached=features.get("tier_reached", observation.tier_reached),
        ),
        tier1_reason=observation.tier1_reason,
        tau_ok=features.get("tau_ok", tau_ok),
        label=label if label in ("related", "drift") else None,
    )


@router.post("/observations/{observation_id}/content", response_model=ContentCaptureResponse)
async def capture_observation_content(
    request: Request,
    observation_id: str,
    excerpt: PageExcerpt,
) -> ContentCaptureResponse:
    store = _store(request)
    current = store.get_current_session()
    observation = store.get_observation(observation_id)
    if (
        not current
        or not current.goal
        or not observation
        or observation.session_id != current.session.id
        or observation.goal_revision != current.goal.goal_revision
    ):
        raise HTTPException(status_code=404, detail="observation not found")
    config = request.app.state.config.time_budget
    if not config.enabled:
        return ContentCaptureResponse(observation_id=observation_id, stored=False, char_count=0)
    stored = store.store_observation_excerpt(
        session_id=observation.session_id,
        observation_id=observation.id,
        text=excerpt.text,
        char_limit=request.app.state.config.tier2.excerpt_char_limit,
        retention_limit=config.recent_excerpts + 1,
    )
    return ContentCaptureResponse(
        observation_id=observation.id,
        stored=True,
        char_count=stored.char_count,
    )


@router.post("/observations/{observation_id}/presence", response_model=PipelineResult)
async def record_observation_presence(
    request: Request,
    observation_id: str,
    body: PresenceRequest,
) -> PipelineResult:
    store = _store(request)
    current = store.get_current_session()
    observation = store.get_observation(observation_id)
    if (
        not current
        or not current.goal
        or not observation
        or observation.session_id != current.session.id
        or observation.goal_revision != current.goal.goal_revision
    ):
        raise HTTPException(status_code=404, detail="observation not found")
    config = request.app.state.config.time_budget
    effective_value = effective_observation_verdict(
        observation.verdict,
        store.page_label_for_observation(observation.id),
    )
    verdict = Verdict(effective_value) if effective_value else None
    if (
        not config.enabled
        or observation.tab_id != body.tab_id
        or observation.url_path_hash != body.url_path_hash
    ):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )
    if body.kind == "heartbeat" and verdict != Verdict.DRIFT:
        store.release_d7_review(observation.session_id, observation.id, "verdict_changed")
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )

    controller_config = effective_controller_config(request.app.state.config, store)
    now = datetime.now(timezone.utc)
    clock_state, accepted, _duplicate = store.record_drift_presence(
        session_id=observation.session_id,
        observation_id=observation.id,
        event_id=body.event_id,
        kind=body.kind,
        tab_id=body.tab_id,
        url_path_hash=body.url_path_hash,
        max_gap_seconds=config.max_heartbeat_gap_seconds,
        review_timeout_seconds=(
            2 * ceil(request.app.state.config.tier2.timeout_seconds)
            + config.heartbeat_seconds
            + TIER2_REVIEW_LEAD_SECONDS
            + 1
        ),
        reset_review_boundary_on_ok=controller_config.type == "streak",
        ts=now,
    )
    if body.kind == "inactive" or verdict != Verdict.DRIFT:
        store.release_d7_review(observation.session_id, observation.id, "presence_inactive")
    if not accepted or body.kind == "inactive" or verdict != Verdict.DRIFT:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )

    prepared = store.get_prepared_d7_review(observation.session_id, observation.id)
    if prepared:
        if prepared.outcome is None and not _d7_review_task_is_running(
            request,
            observation.session_id,
            observation.id,
        ):
            refreshed = store.get_prepared_d7_review(observation.session_id, observation.id)
            if refreshed and refreshed.outcome is not None:
                return _resolve_prepared_d7_review(
                    request,
                    current,
                    observation,
                    verdict,
                    refreshed.goal_revision,
                    refreshed.deliver_after,
                    refreshed.outcome,
                    now,
                )
            # The process may have restarted while an async provider call was
            # in flight. Drop the orphaned queue and start a fresh review from
            # the current server-owned clock below.
            store.release_d7_review(
                observation.session_id,
                observation.id,
                "queued_review_orphaned",
            )
            clock_state = store.get_drift_clock_state(observation.session_id)
        else:
            return _resolve_prepared_d7_review(
                request,
                current,
                observation,
                verdict,
                prepared.goal_revision,
                prepared.deliver_after,
                prepared.outcome,
                now,
            )

    eligible = time_review_is_eligible(store, controller_config, observation.session_id, now)
    thresholds = thresholds_for_budget(config, current.goal.available_time_minutes)
    seconds_until_due = seconds_until_review_due(
        clock_state,
        controller_config.type,
        thresholds,
        eligible,
    )
    if seconds_until_due is None:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )
    if seconds_until_due > TIER2_REVIEW_LEAD_SECONDS:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
            next_review_check_seconds=seconds_until_due - TIER2_REVIEW_LEAD_SECONDS,
        )
    if not store.begin_d7_review(observation.session_id, observation.id, now):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )

    delivery_not_before = now + timedelta(seconds=seconds_until_due)
    if not store.queue_d7_review(
        observation.session_id,
        observation.id,
        observation.goal_revision,
        delivery_not_before,
        ts=now,
    ):
        store.release_d7_review(observation.session_id, observation.id, "queue_failed")
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )
    _start_d7_review_task(
        request,
        current,
        observation,
        controller_config,
        thresholds,
        clock_state,
        now,
        seconds_until_due,
    )
    # Let immediate/local providers finish in the same event-loop turn while
    # keeping network-backed providers detached from the MV3 request lifetime.
    await asyncio.sleep(0)
    if seconds_until_due == 0:
        ready = store.get_prepared_d7_review(observation.session_id, observation.id)
        if ready and ready.outcome is not None:
            return _resolve_prepared_d7_review(
                request,
                current,
                observation,
                verdict,
                ready.goal_revision,
                ready.deliver_after,
                ready.outcome,
                now,
            )
    return PipelineResult(
        action=PipelineAction.NONE,
        observation_id=observation.id,
        verdict=verdict,
        page=observation_page_info(observation),
        next_review_check_seconds=max(1, seconds_until_due),
    )


def _d7_review_task_key(session_id: str, observation_id: str) -> str:
    return f"{session_id}:{observation_id}"


def _d7_review_tasks(request: Request) -> dict[str, asyncio.Task[None]]:
    tasks = getattr(request.app.state, "d7_review_tasks", None)
    if tasks is None:
        tasks = {}
        request.app.state.d7_review_tasks = tasks
    return tasks


def _d7_review_task_is_running(
    request: Request,
    session_id: str,
    observation_id: str,
) -> bool:
    task = _d7_review_tasks(request).get(_d7_review_task_key(session_id, observation_id))
    return bool(task and not task.done())


def _start_d7_review_task(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    controller_config: ControllerConfig,
    thresholds: TimeBudgetThresholds,
    clock_state: DriftClockStateRecord,
    now: datetime,
    seconds_until_due: int,
) -> None:
    store = _store(request)
    tasks = _d7_review_tasks(request)
    key = _d7_review_task_key(observation.session_id, observation.id)

    async def run() -> None:
        try:
            await _run_d7_review(
                request,
                current,
                observation,
                controller_config,
                thresholds,
                clock_state,
                now,
                seconds_until_due,
            )
        except asyncio.CancelledError:
            store.release_d7_review(observation.session_id, observation.id, "review_aborted")
            raise
        except Exception:
            store.release_d7_review(observation.session_id, observation.id, "review_aborted")
            logger.exception("D7 Tier 2 background review failed")

    task = asyncio.create_task(run())
    tasks[key] = task

    def forget(completed: asyncio.Task[None]) -> None:
        if tasks.get(key) is completed:
            tasks.pop(key, None)

    task.add_done_callback(forget)


async def _run_d7_review(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    controller_config: ControllerConfig,
    thresholds: TimeBudgetThresholds,
    clock_state: DriftClockStateRecord,
    now: datetime,
    seconds_until_due: int,
) -> None:
    assert current.goal is not None
    store = _store(request)
    config = request.app.state.config.time_budget
    delivery_not_before = now + timedelta(seconds=seconds_until_due)
    mode_seconds = mode_clock_seconds(clock_state, controller_config.type) + seconds_until_due
    current_page_seconds = clock_state.current_page_drift_seconds + seconds_until_due
    time_context = {
        "available_time_minutes": current.goal.available_time_minutes,
        "controller_type": controller_config.type,
        "total_seconds": thresholds.total_seconds,
        "per_page_seconds": thresholds.per_page_seconds,
        "current_page_drift_seconds": current_page_seconds,
        "mode_clock_seconds": mode_seconds,
    }
    current_excerpt = store.get_observation_excerpt(observation.id)
    recent_titles = store.recent_observation_summaries(
        observation.session_id,
        request.app.state.config.tier2.recent_observations,
    )
    settings = runtime_settings(request.app.state.config, store)
    persona = resolve_persona(
        getattr(request.app.state, "persona_set", None),
        settings,
        request.app.state.config.delivery.persona,
    )
    recent_content = []
    if current_excerpt and current_excerpt.text:
        recent_content = [
            item
            for item in store.recent_observation_content(
                observation.session_id,
                config.recent_excerpts + 1,
                config.recent_excerpt_char_limit,
            )
            if item.observation_id != observation.id
        ][-config.recent_excerpts :]
    else:
        store.record_d7_content_unavailable(observation.session_id, observation.id, now)

    payload = build_tier2_review_payload(
        current.goal,
        observation,
        recent_titles,
        current_excerpt.text if current_excerpt else None,
        recent_content,
        time_context,
        request.app.state.config.tier2,
    )
    outcome = await _review_tier2(
        request,
        current,
        observation,
        payload,
        time_context,
        persona,
        nagging_as_of=delivery_not_before,
    )
    completed_at = datetime.now(timezone.utc)
    effective_value = effective_observation_verdict(
        observation.verdict,
        store.page_label_for_observation(observation.id),
    )
    if (
        not store.d7_review_is_current(observation.session_id, observation.id)
        or not store.goal_revision_is_current(observation.session_id, observation.goal_revision)
        or effective_value != Verdict.DRIFT.value
        or not time_review_is_eligible(
            store,
            controller_config,
            observation.session_id,
            completed_at,
        )
    ):
        store.release_d7_review(observation.session_id, observation.id, "review_invalidated")
        return

    prepared_outcome = _serialize_prepared_d7_outcome(
        outcome,
        controller_config.type,
        thresholds.total_seconds,
        mode_seconds,
    )
    prepared = store.prepare_d7_review(
        observation.session_id,
        observation.id,
        observation.goal_revision,
        delivery_not_before,
        prepared_outcome,
        ts=completed_at,
    )
    if not prepared:
        store.release_d7_review(observation.session_id, observation.id, "prepare_failed")


def _resolve_prepared_d7_review(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    verdict: Verdict,
    prepared_goal_revision: int,
    deliver_after: datetime,
    prepared_outcome: dict[str, object] | None,
    now: datetime,
) -> PipelineResult:
    assert current.goal is not None
    store = _store(request)
    controller_config = effective_controller_config(request.app.state.config, store)
    thresholds = thresholds_for_budget(
        request.app.state.config.time_budget,
        current.goal.available_time_minutes,
    )
    effective_value = effective_observation_verdict(
        observation.verdict,
        store.page_label_for_observation(observation.id),
    )
    valid = (
        prepared_goal_revision == observation.goal_revision
        and prepared_goal_revision == current.goal.goal_revision
        and store.d7_review_is_current(observation.session_id, observation.id)
        and effective_value == Verdict.DRIFT.value
        and time_review_is_eligible(store, controller_config, observation.session_id, now)
        and (
            prepared_outcome is None
            or (
                prepared_outcome.get("controller_type") == controller_config.type
                and prepared_outcome.get("total_seconds") == thresholds.total_seconds
            )
        )
    )
    if not valid:
        store.release_d7_review(observation.session_id, observation.id, "prepared_review_invalidated")
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=Verdict(effective_value) if effective_value else None,
            page=observation_page_info(observation),
        )
    if prepared_outcome is None or now < deliver_after:
        seconds = max(1, ceil((deliver_after - now).total_seconds())) if now < deliver_after else 1
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
            next_review_check_seconds=seconds,
        )

    try:
        outcome, mode_seconds = _deserialize_prepared_d7_outcome(prepared_outcome)
    except (KeyError, TypeError, ValueError):
        store.release_d7_review(observation.session_id, observation.id, "prepared_review_corrupt")
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )
    delivery_mode_seconds = max(
        mode_seconds,
        mode_clock_seconds(
            store.get_drift_clock_state(observation.session_id),
            controller_config.type,
        ),
    )
    return _commit_d7_review(
        request,
        current,
        observation,
        verdict,
        controller_config,
        thresholds.total_seconds,
        delivery_mode_seconds,
        outcome,
        now,
    )


def _commit_d7_review(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    verdict: Verdict,
    controller_config: ControllerConfig,
    total_seconds: int,
    mode_seconds: int,
    outcome: Tier2ReviewOutcome,
    now: datetime,
) -> PipelineResult:
    assert current.goal is not None
    store = _store(request)
    if outcome.decision is None or outcome.decision.decision == "defer":
        return _defer_d7_review(
            store,
            observation,
            total_seconds,
            mode_seconds,
            outcome.decision.reason_code if outcome.decision else "provider_error",
            now,
        )

    settings = runtime_settings(request.app.state.config, store)
    persona = resolve_persona(
        getattr(request.app.state, "persona_set", None),
        settings,
        request.app.state.config.delivery.persona,
    )
    max_sentences = (
        persona.max_sentences
        if persona and persona.max_sentences is not None
        else request.app.state.config.delivery.max_sentences
    )
    message = clamp_notification_message(
        outcome.message or fallback_drift_message(current.goal, observation),
        max_sentences,
    )
    controller_state = controller_state_after_intervention(
        store,
        controller_config,
        observation.session_id,
        now=now,
    )
    next_boundary = next_review_boundary(mode_seconds, total_seconds)
    intervention_id = store.commit_d7_review_notification(
        observation.session_id,
        observation.id,
        message,
        controller_state,
        next_boundary,
        ts=now,
    )
    if intervention_id is None:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )
    silent = _delivery_is_silent(settings)
    _handle_delivery_side_effects(
        request,
        observation.session_id,
        intervention_id,
        message,
        settings,
        persona,
        silent,
    )
    return PipelineResult(
        action=PipelineAction.NOTIFY,
        observation_id=observation.id,
        verdict=verdict,
        message=message,
        intervention_id=intervention_id,
        silent=silent,
        page=observation_page_info(observation),
        next_review_check_seconds=_next_d7_review_check_seconds(next_boundary, mode_seconds),
    )


def _serialize_prepared_d7_outcome(
    outcome: Tier2ReviewOutcome,
    controller_type: str,
    total_seconds: int,
    mode_seconds: int,
) -> dict[str, object]:
    decision = None
    if outcome.decision is not None:
        decision = {
            "decision": outcome.decision.decision,
            "reason_code": outcome.decision.reason_code,
            "basis": outcome.decision.basis,
        }
    return {
        "decision": decision,
        "message": outcome.message,
        "controller_type": controller_type,
        "total_seconds": total_seconds,
        "mode_seconds": mode_seconds,
    }


def _deserialize_prepared_d7_outcome(
    payload: dict[str, object],
) -> tuple[Tier2ReviewOutcome, int]:
    raw_decision = payload.get("decision")
    decision = None
    if raw_decision is not None:
        if not isinstance(raw_decision, dict):
            raise TypeError("prepared Tier 2 decision must be an object")
        decision = Tier2Decision(
            decision=raw_decision["decision"],
            reason_code=raw_decision["reason_code"],
            basis=raw_decision["basis"],
        )
    message = payload.get("message")
    if message is not None and not isinstance(message, str):
        raise TypeError("prepared Tier 2 message must be text")
    return Tier2ReviewOutcome(decision=decision, message=message), int(payload["mode_seconds"])


@router.post("/observations/{observation_id}/excerpt", response_model=PipelineResult)
async def confirm_observation_excerpt(
    request: Request,
    observation_id: str,
    excerpt: PageExcerpt,
) -> PipelineResult:
    store = _store(request)
    current = store.get_current_session()
    observation = store.get_observation(observation_id)
    if (
        not current
        or not current.goal
        or not observation
        or observation.session_id != current.session.id
        or observation.goal_revision != current.goal.goal_revision
    ):
        raise HTTPException(status_code=404, detail="observation not found")

    effective_value = effective_observation_verdict(
        observation.verdict,
        store.page_label_for_observation(observation.id),
    )
    verdict = Verdict(effective_value) if effective_value else None
    if verdict != Verdict.DRIFT:
        store.cancel_active_intervention_candidates_for_observation(
            observation.session_id,
            observation.id,
        )
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=observation_page_info(observation),
        )

    candidate = store.get_intervention_candidate_for_observation(observation.id)
    if not candidate:
        raise HTTPException(status_code=409, detail="observation has no intervention candidate")

    candidate, claimed = store.claim_intervention_candidate(candidate.id)
    if not candidate:
        raise HTTPException(status_code=409, detail="intervention candidate not found")
    if not claimed:
        if candidate.status in {"confirmed", "cancelled"} and candidate.terminal_result is not None:
            return PipelineResult.model_validate(candidate.terminal_result)
        if candidate.status == "expired":
            raise HTTPException(status_code=410, detail="intervention candidate expired")
        raise HTTPException(status_code=409, detail=f"intervention candidate is {candidate.status}")

    try:
        recent = store.recent_observation_summaries(
            observation.session_id,
            request.app.state.config.tier2.recent_observations,
        )
        payload = build_tier2_review_payload(
            current.goal,
            observation,
            recent,
            excerpt.text,
            [],
            None,
            request.app.state.config.tier2,
        )
        settings = runtime_settings(request.app.state.config, store)
        persona = resolve_persona(
            getattr(request.app.state, "persona_set", None),
            settings,
            request.app.state.config.delivery.persona,
        )
        outcome = await _review_tier2(
            request,
            current,
            observation,
            payload,
            None,
            persona,
        )
        if not store.goal_revision_is_current(
            observation.session_id,
            observation.goal_revision,
        ):
            return PipelineResult(
                action=PipelineAction.NONE,
                observation_id=observation.id,
                verdict=verdict,
                page=observation_page_info(observation),
            )
        if outcome.decision is None or outcome.decision.decision == "defer":
            terminal_result = PipelineResult(
                action=PipelineAction.NONE,
                observation_id=observation.id,
                verdict=verdict,
            )
            store.resolve_intervention_candidate(
                candidate.id,
                "cancelled",
                terminal_result=terminal_result.model_dump(mode="json"),
            )
            return terminal_result

        max_sentences = (
            persona.max_sentences
            if persona and persona.max_sentences is not None
            else request.app.state.config.delivery.max_sentences
        )
        message = clamp_notification_message(
            outcome.message or fallback_drift_message(current.goal, observation),
            max_sentences,
        )

        effective_value = effective_observation_verdict(
            observation.verdict,
            store.page_label_for_observation(observation.id),
        )
        verdict = Verdict(effective_value) if effective_value else None
        if verdict != Verdict.DRIFT:
            store.cancel_active_intervention_candidates_for_observation(
                observation.session_id,
                observation.id,
            )
            return PipelineResult(
                action=PipelineAction.NONE,
                observation_id=observation.id,
                verdict=verdict,
                page=observation_page_info(observation),
            )

        controller_config = effective_controller_config(request.app.state.config, store)
        confirmed_at = datetime.now(timezone.utc)
        controller_state = controller_state_after_intervention(
            store,
            controller_config,
            observation.session_id,
            now=confirmed_at,
        )
        silent = _delivery_is_silent(settings)
        terminal_result = PipelineResult(
            action=PipelineAction.NOTIFY,
            observation_id=observation.id,
            verdict=verdict,
            message=message,
            silent=silent,
            page=observation_page_info(observation),
        )
        intervention_id = store.commit_confirmed_intervention(
            candidate.id,
            observation.session_id,
            observation.id,
            message,
            controller_state,
            terminal_result=terminal_result.model_dump(mode="json"),
            ts=confirmed_at,
        )
        if intervention_id is None:
            effective_value = effective_observation_verdict(
                observation.verdict,
                store.page_label_for_observation(observation.id),
            )
            return PipelineResult(
                action=PipelineAction.NONE,
                observation_id=observation.id,
                verdict=Verdict(effective_value) if effective_value else None,
                page=observation_page_info(observation),
            )
        _handle_delivery_side_effects(
            request,
            observation.session_id,
            intervention_id,
            message,
            settings,
            persona,
            silent,
        )
        return terminal_result.model_copy(update={"intervention_id": intervention_id})
    except BaseException:
        store.release_intervention_candidate(candidate.id)
        raise


def _defer_d7_review(
    store: SQLiteStore,
    observation: ObservationRecord,
    total_seconds: int,
    mode_seconds: int,
    reason: str,
    now: datetime,
) -> PipelineResult:
    next_boundary = next_review_boundary(mode_seconds, total_seconds)
    store.record_tier2_result(
        session_id=observation.session_id,
        observation_id=observation.id,
        confirm_drift=False,
        message=f"d7_deferred:{reason}",
        ts=now,
    )
    store.defer_d7_review(
        session_id=observation.session_id,
        observation_id=observation.id,
        next_review_mode_seconds=next_boundary,
        reason=reason,
        ts=now,
    )
    verdict = Verdict(observation.verdict) if observation.verdict else None
    return PipelineResult(
        action=PipelineAction.NONE,
        observation_id=observation.id,
        verdict=verdict,
        page=observation_page_info(observation),
        next_review_check_seconds=_next_d7_review_check_seconds(next_boundary, mode_seconds),
    )


def _next_d7_review_check_seconds(next_boundary: int, mode_seconds: int) -> int | None:
    seconds = next_boundary - mode_seconds - TIER2_REVIEW_LEAD_SECONDS
    return seconds if seconds >= 1 else None


@dataclass(frozen=True)
class Tier2ReviewOutcome:
    decision: Tier2Decision | None
    message: str | None = None


async def _review_tier2(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    judge_payload: dict[str, object],
    time_context: dict[str, object] | None,
    persona: Persona | None,
    nagging_as_of: datetime | None = None,
) -> Tier2ReviewOutcome:
    assert current.goal is not None
    runtime = _runtime(request)
    store = _store(request)
    provider = runtime.tier2_provider()
    if not provider:
        if not request.app.state.config.tier2.enabled:
            return Tier2ReviewOutcome(decision=None)
        exc = RuntimeError("tier2 provider unavailable")
        runtime.record_provider_call_failure(2, exc, phase="judge")
        store.record_tier2_provider_error(
            observation.session_id,
            observation.id,
            "ProviderUnavailable",
            phase="judge",
            stage=None,
        )
        return Tier2ReviewOutcome(decision=None)

    try:
        decision = await provider.decide_tier2(
            judge_payload,
            system_prompt=compose_tier2_judge_system_prompt(),
        )
    except Exception as exc:
        runtime.record_provider_call_failure(2, exc, phase="judge")
        store.record_tier2_provider_error(
            observation.session_id,
            observation.id,
            type(exc).__name__,
            phase="judge",
            stage=exc.stage if isinstance(exc, ProviderResponseError) else None,
        )
        return Tier2ReviewOutcome(decision=None)

    if decision.decision == "defer":
        runtime.record_provider_call_success(2)
        return Tier2ReviewOutcome(decision=decision)

    nagging_context = _nagging_context(
        store,
        observation.session_id,
        observation.url_host,
        as_of=nagging_as_of,
    )
    writer_payload = build_tier2_message_payload(
        current.goal,
        observation,
        decision,
        time_context,
        nagging_context,
    )
    try:
        message = await provider.write_tier2_message(
            writer_payload,
            system_prompt=compose_tier2_writer_system_prompt(persona),
        )
        message = message.strip()
        if not message:
            raise ProviderResponseError("writer_empty", "tier2 writer response was empty")
    except Exception as exc:
        runtime.record_provider_call_failure(2, exc, phase="writer")
        store.record_tier2_provider_error(
            observation.session_id,
            observation.id,
            type(exc).__name__,
            phase="writer",
            stage=exc.stage if isinstance(exc, ProviderResponseError) else None,
        )
        nag_count = store.nag_count_today(observation.session_id) + 1
        fallback = format_persona_fallback(persona, current.goal, observation, nag_count)
        return Tier2ReviewOutcome(
            decision=decision,
            message=fallback or fallback_drift_message(current.goal, observation),
        )

    runtime.record_provider_call_success(2)
    return Tier2ReviewOutcome(decision=decision, message=message)


def _nagging_context(
    store: SQLiteStore,
    session_id: str,
    current_host: str | None,
    as_of: datetime | None = None,
) -> dict[str, object]:
    previous_host = store.latest_intervention_observation_host(session_id)
    return {
        "nag_count_today": store.nag_count_today(session_id),
        "last_nag_ignored": store.last_intervention_ignored(session_id),
        "drift_minutes": store.minutes_since_last_ok(session_id, as_of=as_of),
        "repeat_host": bool(current_host and previous_host and current_host == previous_host),
    }


def _handle_delivery_side_effects(
    request: Request,
    session_id: str,
    intervention_id: str,
    message: str,
    settings: dict[str, object],
    persona: Persona | None,
    silent: bool,
) -> None:
    store = _store(request)
    if silent:
        store.record_delivery_suppressed_quiet_hours(session_id, intervention_id)
        return

    if settings.get("voice_enabled"):
        voice = request.app.state.config.delivery.voice.voice
        rate = request.app.state.config.delivery.voice.rate
        if persona and persona.voice:
            voice = persona.voice.voice or voice
            rate = persona.voice.rate or rate
        speak(message, voice, rate)
        store.record_voice_spoken(session_id, intervention_id)


def _delivery_is_silent(settings: dict[str, object]) -> bool:
    try:
        return quiet_hours_active(settings["quiet_hours"])
    except Exception:
        return False

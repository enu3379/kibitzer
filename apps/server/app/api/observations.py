import asyncio
import hashlib
import json
import random
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import ControllerConfig
from ..core.controller_flow import (
    apply_controller,
    confirm_controller_intervention,
    controller_state_after_intervention,
    time_review_is_eligible,
)
from ..core.delivery import clamp_notification_message
from ..core.normalization import (
    browser_nav_embedding_text,
    normalize_browser_nav,
    strip_repeated_title_suffix,
)
from ..core.personas import (
    Persona,
    compose_tier2_system_prompt,
    format_celebration_template,
    format_persona_fallback,
    resolve_persona,
)
from ..core.page_labels import apply_page_label_override
from ..core.relevance import (
    DRIFT_RELEVANCE,
    RELATED_RELEVANCE,
    tier0_score_parts,
    tier1_final_relevance,
)
from ..core.runtime_settings import effective_controller_config, quiet_hours_active, runtime_settings
from ..core.runtime_resources import RuntimeResources
from ..core.tier1_payload import build_tier1_payload
from ..core.tier2_payload import (
    build_d7_content_payload,
    build_d7_title_payload,
    build_tier2_payload,
    fallback_drift_message,
)
from ..core.time_budget import (
    TimeBudgetThresholds,
    mode_clock_seconds,
    next_review_boundary,
    review_is_due,
    thresholds_for_budget,
)
from ..core.voice import speak
from ..providers.judges.base import Tier2Result
from ..privacy.domain_filter import SensitiveDomainRules, drop_decision_for_url
from ..schemas import PageExcerpt, PageInfo, PipelineAction, PipelineResult, PipelineResultKind, RawObservation, Verdict
from ..storage.sqlite import (
    ControllerStateRecord,
    CurrentSessionRecord,
    DriftClockStateRecord,
    IdempotencyConflictError,
    ObservationRecord,
    ReturnCandidateRecord,
    SQLiteStore,
    effective_observation_verdict,
)

router = APIRouter()

CANDIDATE_RESUME_TTL_SECONDS = 60


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


def _sensitive_domain_rules(request: Request) -> SensitiveDomainRules:
    return request.app.state.sensitive_domain_rules


def _runtime(request: Request) -> RuntimeResources:
    return request.app.state.runtime


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
    observation = store.latest_observation_for_tab(current.session.id, tab_id)
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
    current = store.get_current_session()
    idempotency_key = raw.idempotency_key
    if idempotency_key is None:
        return await _ingest_browser_nav_once(request, raw, current)

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
        result = await _ingest_browser_nav_once(request, raw, current)
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


async def _ingest_browser_nav_once(
    request: Request,
    raw: RawObservation,
    current: CurrentSessionRecord | None,
) -> PipelineResult:
    session_id = current.session.id if current else None

    decision = drop_decision_for_url(str(raw.payload.url), _sensitive_domain_rules(request))
    if decision.should_drop:
        _store(request).record_dropped_observation(
            session_id=session_id,
            source=raw.source,
            url_host=decision.host,
            reason=decision.reason or "sensitive_domain",
            ts=raw.ts,
        )
        return PipelineResult(action=PipelineAction.NONE)

    if not current:
        return PipelineResult(action=PipelineAction.NONE)

    observation = normalize_browser_nav(raw, current.session.id)
    if current.goal:
        tau_ok = float(runtime_settings(request.app.state.config, _store(request))["relevance"]["tau_ok"])
        runtime = _runtime(request)
        embedding_text = strip_repeated_title_suffix(
            browser_nav_embedding_text(observation),
            _store(request).recent_titles_for_host(str(observation.payload.get("url_host") or "")),
        )
        vectors = await runtime.embedding_provider().embed([embedding_text])
        observation.features.emb = vectors[0]
        score = tier0_score_parts(
            emb=observation.features.emb,
            exemplars=current.goal.exemplars,
            anchor=_store(request).anchor_value(
                current.session.id,
                request.app.state.config.relevance.anchor_window,
            ),
            beta=request.app.state.config.relevance.beta,
            derived_exemplars=current.goal.derived_vectors,
            derived_tau=request.app.state.config.goal_enrichment.derived_tau,
        )
        observation.features.r0 = score.score
        observation.features.tau_ok = tau_ok
        observation.features.exemplar_score = score.exemplar_score
        observation.features.derived_score = score.derived_score
        observation.features.r_final = observation.features.r0
        observation.features.tier_reached = 0
        observation.verdict = (
            Verdict.OK if observation.features.r0 >= tau_ok else Verdict.DRIFT
        )
        tier1_provider = runtime.tier1_provider()
        if observation.verdict == Verdict.DRIFT and tier1_provider:
            recent = _store(request).recent_observation_summaries(
                current.session.id,
                request.app.state.config.tier1.recent_observations,
            )
            payload = build_tier1_payload(current.goal, observation, recent, request.app.state.config.tier1)
            try:
                result = await tier1_provider.classify_tier1(payload)
            except Exception as exc:
                # Tier 1 is best-effort: on provider failure keep the Tier 0 verdict.
                runtime.record_provider_call_failure(1, exc)
                _store(request).record_tier1_provider_error(
                    session_id=current.session.id,
                    observation_id=observation.id,
                    error_type=type(exc).__name__,
                    ts=observation.ts,
                )
            else:
                runtime.record_provider_call_success(1)
                observation.verdict = result.verdict
                observation.features.r_final = tier1_final_relevance(result.verdict)
                observation.tier1_reason = result.reason
                observation.features.tier_reached = 1
                _store(request).record_tier1_result(
                    session_id=current.session.id,
                    observation_id=observation.id,
                    verdict=result.verdict.value,
                    reason=result.reason,
                    ts=observation.ts,
                )
        # Anchor admission guard: only pages with genuine goal affinity — direct
        # exemplar similarity, or an LLM-vetted OK — may steer the anchor. An OK
        # that rode the anchor alone keeps its verdict but gets no vote.
        observation.features.anchor_eligible = (
            score.exemplar_score >= request.app.state.config.relevance.anchor_epsilon
            or score.derived_score >= request.app.state.config.goal_enrichment.derived_tau
            or (observation.verdict == Verdict.OK and (observation.features.tier_reached or 0) >= 1)
        )
    store = _store(request)
    controller_config = effective_controller_config(request.app.state.config, store)
    controller_state_before = store.get_controller_state(observation.session_id)
    drift_confirmed = _drift_confirmed_after_observation(
        controller_config,
        controller_state_before,
        observation.verdict,
        observation.features.r_final,
    )
    store.record_observation(observation)
    result = apply_controller(
        store,
        controller_config,
        observation,
        defer_intervention=request.app.state.config.time_budget.enabled,
    )
    if result.action == PipelineAction.REQUEST_EXCERPT:
        requested_at = datetime.now(timezone.utc)
        remaining_dwell_seconds = max(
            0,
            request.app.state.config.dwell.tier2_seconds
            - request.app.state.config.dwell.observation_seconds,
        )
        candidate, created = store.create_intervention_candidate(
            observation.session_id,
            observation.id,
            expires_at=requested_at
            + timedelta(seconds=remaining_dwell_seconds + CANDIDATE_RESUME_TTL_SECONDS),
            ts=requested_at,
        )
        if created:
            store.record_intervention_requested(
                observation.session_id,
                observation.id,
                candidate_id=candidate.id,
                ts=requested_at,
            )
            result.candidate_id = candidate.id
        else:
            result = PipelineResult(
                action=PipelineAction.NONE,
                observation_id=observation.id,
                verdict=observation.verdict,
                page=_page_info(observation),
            )
    return_candidate = store.note_attachment_observation(
        observation.session_id,
        observation.verdict.value if observation.verdict else None,
        observation.ts,
        drift_confirmed,
    )
    if result.action == PipelineAction.NONE:
        celebration = _maybe_create_celebration(request, current, observation, return_candidate)
        if celebration:
            return celebration
    return result


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
    if not current or not current.goal or not observation or observation.session_id != current.session.id:
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
    if not current or not current.goal or not observation or observation.session_id != current.session.id:
        raise HTTPException(status_code=404, detail="observation not found")
    config = request.app.state.config.time_budget
    verdict = Verdict(observation.verdict) if observation.verdict else None
    if (
        not config.enabled
        or observation.tab_id != body.tab_id
        or observation.url_path_hash != body.url_path_hash
    ):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
        )
    if body.kind == "heartbeat" and verdict != Verdict.DRIFT:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
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
            int(request.app.state.config.tier2.timeout_seconds)
            + config.heartbeat_seconds
            + 1
        ),
        reset_review_boundary_on_ok=controller_config.type == "streak",
        ts=now,
    )
    if not accepted or body.kind == "inactive" or verdict != Verdict.DRIFT:
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
        )

    eligible = time_review_is_eligible(store, controller_config, observation.session_id, now)
    thresholds = thresholds_for_budget(config, current.goal.available_time_minutes)
    if not review_is_due(clock_state, controller_config.type, thresholds, eligible):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
        )
    if not store.begin_d7_review(observation.session_id, observation.id, now):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
        )

    try:
        return await _run_d7_review(
            request,
            current,
            observation,
            verdict,
            controller_config,
            thresholds,
            clock_state,
            now,
        )
    finally:
        # Conditional release is a no-op after a normal defer/notification.
        # It protects the page from a permanent lock on cancellation, restart,
        # or an unexpected exception anywhere in the review body.
        store.release_d7_review(observation.session_id, observation.id, "review_aborted")


async def _run_d7_review(
    request: Request,
    current: CurrentSessionRecord,
    observation: ObservationRecord,
    verdict: Verdict,
    controller_config: ControllerConfig,
    thresholds: TimeBudgetThresholds,
    clock_state: DriftClockStateRecord,
    now: datetime,
) -> PipelineResult:
    assert current.goal is not None
    store = _store(request)
    config = request.app.state.config.time_budget
    mode_seconds = mode_clock_seconds(clock_state, controller_config.type)
    time_context = {
        "available_time_minutes": current.goal.available_time_minutes,
        "controller_type": controller_config.type,
        "total_seconds": thresholds.total_seconds,
        "per_page_seconds": thresholds.per_page_seconds,
        "current_page_drift_seconds": clock_state.current_page_drift_seconds,
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
    system_prompt = compose_tier2_system_prompt(persona) if persona else None
    title_payload = build_d7_title_payload(current.goal, observation, recent_titles, time_context)
    _inject_nagging_context(store, title_payload, observation.session_id, observation.url_host)
    payloads = [title_payload]
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
        content_payload = build_d7_content_payload(
            current.goal,
            observation,
            current_excerpt.text,
            recent_content,
            time_context,
        )
        _inject_nagging_context(store, content_payload, observation.session_id, observation.url_host)
        payloads.append(content_payload)
    else:
        store.record_d7_content_unavailable(observation.session_id, observation.id, now)

    results = await asyncio.gather(
        *(
            _confirm_d7_tier2(
                request,
                observation.session_id,
                observation.id,
                payload,
                system_prompt,
            )
            for payload in payloads
        )
    )
    if not store.d7_review_is_current(observation.session_id, observation.id):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=verdict,
            page=_page_info(observation),
        )
    available_results = [result for result in results if result is not None]
    if any(not result.confirm_drift for result in available_results):
        return _defer_d7_review(
            store,
            observation,
            thresholds.total_seconds,
            mode_seconds,
            "acceptable_side_branch",
            now,
        )

    max_sentences = (
        persona.max_sentences
        if persona and persona.max_sentences is not None
        else request.app.state.config.delivery.max_sentences
    )
    provider_message = next(
        (result.message for result in reversed(available_results) if result.message),
        None,
    )
    if not available_results:
        nag_count = store.nag_count_today(observation.session_id) + 1
        provider_message = format_persona_fallback(persona, current.goal, observation, nag_count)
    message = clamp_notification_message(
        provider_message or fallback_drift_message(current.goal, observation),
        max_sentences,
    )
    store.record_tier2_result(
        session_id=observation.session_id,
        observation_id=observation.id,
        confirm_drift=True,
        message=message,
        ts=now,
    )
    intervention_id = store.create_intervention(observation.session_id, observation.id, message, ts=now)
    confirm_controller_intervention(store, controller_config, observation.session_id, now)
    store.complete_d7_review_notification(
        observation.session_id,
        observation.id,
        next_review_boundary(mode_seconds, thresholds.total_seconds),
        now,
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
        page=_page_info(observation),
    )


@router.post("/observations/{observation_id}/excerpt", response_model=PipelineResult)
async def confirm_observation_excerpt(
    request: Request,
    observation_id: str,
    excerpt: PageExcerpt,
) -> PipelineResult:
    store = _store(request)
    current = store.get_current_session()
    observation = store.get_observation(observation_id)
    if not current or not current.goal or not observation or observation.session_id != current.session.id:
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
            page=_page_info(observation),
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
        payload = build_tier2_payload(current.goal, observation, recent, excerpt, request.app.state.config.tier2)
        _inject_nagging_context(store, payload, observation.session_id, observation.url_host)
        settings = runtime_settings(request.app.state.config, store)
        persona = resolve_persona(
            getattr(request.app.state, "persona_set", None),
            settings,
            request.app.state.config.delivery.persona,
        )
        system_prompt = compose_tier2_system_prompt(persona) if persona else None
        result = await _confirm_tier2(
            request,
            observation.session_id,
            observation.id,
            payload,
            system_prompt=system_prompt,
            persona=persona,
        )
        max_sentences = (
            persona.max_sentences
            if persona and persona.max_sentences is not None
            else request.app.state.config.delivery.max_sentences
        )
        message = clamp_notification_message(
            result.message or fallback_drift_message(current.goal, observation),
            max_sentences,
        )

        if not result.confirm_drift:
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
                page=_page_info(observation),
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
            page=_page_info(observation),
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
                page=_page_info(observation),
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


def _page_info(observation) -> PageInfo:
    payload = getattr(observation, "payload", {}) or {}
    return PageInfo(
        host=getattr(observation, "url_host", None) or payload.get("url_host"),
        title=getattr(observation, "title", None) or payload.get("title"),
    )


def _drift_confirmed_after_observation(
    config: ControllerConfig,
    state: ControllerStateRecord,
    verdict: Verdict | None,
    r: float | None,
) -> bool:
    if verdict != Verdict.DRIFT:
        return False
    obs_count = state.obs_count + 1
    if obs_count < config.coldstart_observations:
        return False
    if config.type == "alignment":
        score = _next_alignment_score(config, state, verdict, r)
        return state.drift_latched or score < config.theta_low
    return state.streak + 1 >= config.k


def _next_alignment_score(
    config: ControllerConfig,
    state: ControllerStateRecord,
    verdict: Verdict,
    r: float | None,
) -> float:
    if r is None:
        r = 1.0 if verdict == Verdict.OK else 0.0
    alpha = min(0.99, max(0.0, config.alignment_alpha))
    previous = float(r) if state.alignment_score is None else state.alignment_score
    return alpha * previous + (1.0 - alpha) * float(r)


def _maybe_create_celebration(
    request: Request,
    current: CurrentSessionRecord,
    observation,
    candidate: ReturnCandidateRecord | None,
) -> PipelineResult | None:
    if not candidate or not current.goal:
        return None

    return_seconds = max(0, int((observation.ts - candidate.drift_started_at).total_seconds()))
    return_minutes = return_seconds // 60  # template placeholder stays whole minutes
    config = request.app.state.config.celebration
    if return_seconds < config.min_drift_minutes * 60:
        return None
    if candidate.last_celebration_ts:
        elapsed = (observation.ts - candidate.last_celebration_ts).total_seconds()
        if elapsed < config.cooldown_seconds:
            return None

    settings = runtime_settings(request.app.state.config, _store(request))
    try:
        if quiet_hours_active(settings["quiet_hours"]):
            return None
    except Exception:
        pass

    persona = resolve_persona(
        getattr(request.app.state, "persona_set", None),
        settings,
        request.app.state.config.delivery.persona,
    )
    templates = list(persona.celebrate_templates) if persona else []
    if not templates:
        return None
    choices = [template for template in templates if template != candidate.last_celebration_template]
    template = random.choice(choices or templates)
    message = format_celebration_template(template, current.goal, return_minutes)
    if not message:
        return None

    _store(request).record_celebration_delivered(
        observation.session_id,
        observation.id,
        return_minutes,
        template,
        ts=observation.ts,
    )
    return PipelineResult(
        action=PipelineAction.NOTIFY,
        kind=PipelineResultKind.CELEBRATION,
        observation_id=observation.id,
        verdict=observation.verdict,
        message=message,
        page=_page_info(observation),
    )


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
        page=_page_info(observation),
    )


async def _confirm_d7_tier2(
    request: Request,
    session_id: str,
    observation_id: str,
    payload: dict[str, object],
    system_prompt: str | None,
) -> Tier2Result | None:
    runtime = _runtime(request)
    provider = runtime.tier2_provider()
    if not provider:
        return None
    try:
        result = await provider.confirm_tier2(payload, system_prompt=system_prompt)
    except Exception as exc:
        runtime.record_provider_call_failure(2, exc)
        _store(request).record_tier2_provider_error(session_id, observation_id, type(exc).__name__)
        return None
    runtime.record_provider_call_success(2)
    return result


async def _confirm_tier2(
    request: Request,
    session_id: str,
    observation_id: str,
    payload: dict[str, object],
    system_prompt: str | None = None,
    persona: Persona | None = None,
) -> Tier2Result:
    runtime = _runtime(request)
    provider = runtime.tier2_provider()
    if provider:
        try:
            result = await provider.confirm_tier2(payload, system_prompt=system_prompt)
        except Exception as exc:
            runtime.record_provider_call_failure(2, exc)
            _store(request).record_tier2_provider_error(session_id, observation_id, type(exc).__name__)
        else:
            runtime.record_provider_call_success(2)
            return result
    current = _store(request).get_current_session()
    observation = _store(request).get_observation(observation_id)
    if current and current.goal and observation:
        nag_count = _store(request).nag_count_today(session_id) + 1
        message = format_persona_fallback(persona, current.goal, observation, nag_count)
        return Tier2Result(
            confirm_drift=True,
            message=message or fallback_drift_message(current.goal, observation),
        )
    return Tier2Result(confirm_drift=False, message=None)


def _inject_nagging_context(
    store: SQLiteStore,
    payload: dict[str, object],
    session_id: str,
    current_host: str | None,
) -> None:
    previous_host = store.latest_intervention_observation_host(session_id)
    payload["nagging_context"] = {
        "nag_count_today": store.nag_count_today(session_id),
        "last_nag_ignored": store.last_intervention_ignored(session_id),
        "drift_minutes": store.minutes_since_last_ok(session_id),
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

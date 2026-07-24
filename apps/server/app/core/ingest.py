from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from ..config import AppConfig, ControllerConfig
from ..privacy.domain_filter import SensitiveDomainRules, drop_decision_for_url
from ..providers.judges.base import ProviderResponseError
from ..schemas import Observation, PageInfo, PipelineAction, PipelineResult, PipelineResultKind, RawObservation, Verdict
from ..storage.sqlite import (
    ControllerStateRecord,
    CurrentSessionRecord,
    ObservationRecord,
    ReturnCandidateRecord,
    SQLiteStore,
)
from .audit_routing import choose_audit_trigger, host_family
from .controller_flow import apply_controller
from .normalization import (
    browser_nav_embedding_text,
    normalize_browser_nav,
    strip_repeated_title_suffix,
)
from .personas import PersonaSet, format_celebration_template, resolve_persona
from .relevance import (
    anchor_admission_eligible,
    tier0_score_parts,
    tier1_final_relevance,
)
from .title_quality import classify_title, is_low_quality_title
from .runtime_resources import RuntimeResources
from .runtime_settings import effective_controller_config, quiet_hours_active, runtime_settings
from .tier1_payload import build_tier1_payload


CANDIDATE_RESUME_TTL_SECONDS = 60


async def ingest_browser_nav(
    raw: RawObservation,
    current: CurrentSessionRecord | None,
    *,
    config: AppConfig,
    store: SQLiteStore,
    runtime: RuntimeResources,
    sensitive_domain_rules: SensitiveDomainRules,
    persona_set: PersonaSet | None,
) -> PipelineResult:
    session_id = current.session.id if current else None
    captured_goal_revision = current.goal.goal_revision if current and current.goal else None

    decision = drop_decision_for_url(str(raw.payload.url), sensitive_domain_rules)
    if decision.should_drop:
        store.record_dropped_observation(
            session_id=session_id,
            source=raw.source,
            url_host=decision.host,
            reason=decision.reason or "sensitive_domain",
            ts=raw.ts,
        )
        return PipelineResult(action=PipelineAction.NONE)

    if not current or not current.goal:
        return PipelineResult(action=PipelineAction.NONE)

    observation = normalize_browser_nav(raw, current.session.id)
    assert captured_goal_revision is not None
    store.set_observation_processing_stage(observation, captured_goal_revision, "tier0")
    try:
        tau_ok = float(runtime_settings(config, store)["relevance"]["tau_ok"])
        embedding_text = strip_repeated_title_suffix(
            browser_nav_embedding_text(observation),
            store.recent_titles_for_host(str(observation.payload.get("url_host") or "")),
        )
        title_quality = classify_title(embedding_text)
        observation.features.title_quality = title_quality
        vectors = await runtime.embedding_provider().embed([embedding_text])
        observation.features.emb = vectors[0]
        score = tier0_score_parts(
            emb=observation.features.emb,
            exemplars=current.goal.exemplars,
            anchor=store.anchor_value(
                current.session.id,
                config.relevance.anchor_window,
                captured_goal_revision,
            ),
            beta=config.relevance.beta,
            derived_exemplars=current.goal.derived_vectors,
            derived_tau=config.goal_enrichment.derived_tau,
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
        family = host_family(str(observation.payload.get("url_host") or ""))
        audit_payload: dict[str, object] | None = None
        if observation.verdict == Verdict.OK and tier1_provider:
            audit_config = config.judgment_audit
            audit_decision = choose_audit_trigger(
                verdict=observation.verdict,
                tier0_score=observation.features.r0,
                title_quality=title_quality,
                host_family=family,
                host_family_verdicts=_host_family_verdicts(
                    store,
                    current.session.id,
                    family,
                    observation.ts,
                    audit_config.mixed_host_window_minutes,
                ),
                config=audit_config,
            )
            if audit_decision.trigger:
                observation.features.audit_trigger = audit_decision.trigger
                audit_payload = {
                    "trigger": audit_decision.trigger,
                    "tier0_score": observation.features.r0,
                }

        cached_audit = None
        if audit_payload:
            cached_audit = _cached_audit_outcome(
                store,
                current.session.id,
                family,
                str(observation.payload.get("title") or ""),
            )

        if cached_audit is not None:
            # Same (host family, title) was already audited this session: reuse
            # the outcome instead of re-spending a Tier-1 call on a revisit.
            observation.verdict = Verdict(cached_audit.verdict)
            observation.features.r_final = tier1_final_relevance(observation.verdict)
            observation.tier1_reason = cached_audit.tier1_reason
            observation.features.tier_reached = 1
            observation.features.audit_cached = True
            store.record_tier1_audit_reused(
                session_id=current.session.id,
                observation_id=observation.id,
                source_observation_id=cached_audit.id,
                verdict=cached_audit.verdict,
                audit=audit_payload,
                ts=observation.ts,
            )
        elif tier1_provider and (observation.verdict == Verdict.DRIFT or audit_payload):
            store.set_observation_processing_stage(observation, captured_goal_revision, "tier1")
            recent = store.recent_observation_summaries(
                current.session.id,
                config.tier1.recent_observations,
                captured_goal_revision,
            )
            payload = build_tier1_payload(current.goal, observation, recent, config.tier1)
            if audit_payload:
                payload["audit"] = audit_payload
            try:
                result = await tier1_provider.classify_tier1(payload)
            except Exception as exc:
                # Tier 1 is best-effort: on provider failure keep the Tier 0 verdict.
                runtime.record_provider_call_failure(1, exc, phase="judge")
                store.record_tier1_provider_error(
                    session_id=current.session.id,
                    observation_id=observation.id,
                    error_type=type(exc).__name__,
                    phase="judge",
                    stage=exc.stage if isinstance(exc, ProviderResponseError) else None,
                    ts=observation.ts,
                    audit=audit_payload,
                )
            else:
                runtime.record_provider_call_success(1)
                observation.verdict = result.verdict
                observation.features.r_final = tier1_final_relevance(result.verdict)
                observation.tier1_reason = result.reason
                observation.features.tier_reached = 1
                store.record_tier1_result(
                    session_id=current.session.id,
                    observation_id=observation.id,
                    verdict=result.verdict.value,
                    reason=result.reason,
                    ts=observation.ts,
                    audit=audit_payload,
                )
        # Anchor admission guard: only pages with genuine goal affinity — direct
        # exemplar similarity, or an LLM-vetted OK — may steer the anchor. An OK
        # that rode the anchor alone keeps its verdict but gets no vote. Low-
        # quality titles (generic/url_like/empty) never steer the anchor at all:
        # their embeddings describe platform furniture, not the goal.
        observation.features.anchor_eligible = (
            False
            if is_low_quality_title(title_quality)
            else anchor_admission_eligible(
                score,
                has_derived_exemplars=bool(current.goal.derived_vectors),
                anchor_epsilon=config.relevance.anchor_epsilon,
                derived_tau=config.goal_enrichment.derived_tau,
                verdict=observation.verdict,
                tier_reached=observation.features.tier_reached,
            )
        )
        store.record_observation(observation, goal_revision=captured_goal_revision)
    finally:
        store.clear_observation_processing_state(observation.id)
    if (
        captured_goal_revision is not None
        and not store.goal_revision_is_current(observation.session_id, captured_goal_revision)
    ):
        return PipelineResult(
            action=PipelineAction.NONE,
            observation_id=observation.id,
            verdict=observation.verdict,
            page=observation_page_info(observation),
        )

    controller_config = effective_controller_config(config, store)
    controller_state_before = store.get_controller_state(observation.session_id)
    drift_confirmed = _drift_confirmed_after_observation(
        controller_config,
        controller_state_before,
        observation.verdict,
        observation.features.r_final,
    )
    result = apply_controller(
        store,
        controller_config,
        observation,
        defer_intervention=config.time_budget.enabled,
    )
    if result.action == PipelineAction.REQUEST_EXCERPT:
        requested_at = datetime.now(timezone.utc)
        dwell_settings = runtime_settings(config, store)["dwell"]
        remaining_dwell_seconds = max(
            0,
            int(dwell_settings["tier2_seconds"])
            - int(dwell_settings["observation_seconds"]),
        )
        candidate, created = store.create_intervention_candidate(
            observation.session_id,
            observation.id,
            expires_at=requested_at
            + timedelta(seconds=remaining_dwell_seconds + CANDIDATE_RESUME_TTL_SECONDS),
            ts=requested_at,
            goal_revision=captured_goal_revision,
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
                page=observation_page_info(observation),
            )
    attachment_verdict = observation.verdict.value if observation.verdict else None
    if (
        observation.verdict == Verdict.OK
        and observation.features.anchor_eligible is False
    ):
        attachment_verdict = None
    return_candidate = store.note_attachment_observation(
        observation.session_id,
        attachment_verdict,
        observation.ts,
        drift_confirmed,
    )
    if result.action == PipelineAction.NONE:
        celebration = _maybe_create_celebration(
            config,
            store,
            persona_set,
            current,
            observation,
            return_candidate,
        )
        if celebration:
            return celebration
    return result


def _host_family_verdicts(
    store: SQLiteStore,
    session_id: str,
    family: str,
    observed_at: datetime,
    window_minutes: float,
) -> set[Verdict]:
    if not family:
        return set()
    cutoff = observed_at - timedelta(minutes=window_minutes)
    verdicts: set[Verdict] = set()
    for url_host, verdict in store.host_verdicts_in_time_range(session_id, cutoff, observed_at):
        if host_family(url_host) != family:
            continue
        if verdict in {Verdict.OK.value, Verdict.DRIFT.value}:
            verdicts.add(Verdict(verdict))
    return verdicts


def _cached_audit_outcome(
    store: SQLiteStore,
    session_id: str,
    family: str,
    title: str,
) -> ObservationRecord | None:
    normalized_title = title.strip()
    if not family or not normalized_title:
        return None
    for prior in store.observations_with_title(session_id, normalized_title):
        if host_family(prior.url_host) != family:
            continue
        if not prior.features.get("audit_trigger"):
            continue
        tier_reached = prior.features.get("tier_reached", prior.tier_reached)
        if not isinstance(tier_reached, int) or tier_reached < 1:
            continue
        if prior.verdict in {Verdict.OK.value, Verdict.DRIFT.value}:
            return prior
    return None


def observation_page_info(observation: Observation | ObservationRecord) -> PageInfo:
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
    config: AppConfig,
    store: SQLiteStore,
    persona_set: PersonaSet | None,
    current: CurrentSessionRecord,
    observation: Observation,
    candidate: ReturnCandidateRecord | None,
) -> PipelineResult | None:
    if not candidate or not current.goal:
        return None

    return_seconds = max(0, int((observation.ts - candidate.drift_started_at).total_seconds()))
    return_minutes = return_seconds // 60  # template placeholder stays whole minutes
    celebration_config = config.celebration
    if return_seconds < celebration_config.min_drift_minutes * 60:
        return None
    if candidate.last_celebration_ts:
        elapsed = (observation.ts - candidate.last_celebration_ts).total_seconds()
        if elapsed < celebration_config.cooldown_seconds:
            return None

    settings = runtime_settings(config, store)
    try:
        if quiet_hours_active(settings["quiet_hours"]):
            return None
    except ValueError:
        return None

    persona = resolve_persona(persona_set, settings, config.delivery.persona)
    templates = list(persona.celebrate_templates) if persona else []
    if not templates:
        return None
    choices = [template for template in templates if template != candidate.last_celebration_template]
    template = random.choice(choices or templates)
    message = format_celebration_template(template, current.goal, return_minutes)
    if not message:
        return None

    store.record_celebration_delivered(
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
        page=observation_page_info(observation),
    )

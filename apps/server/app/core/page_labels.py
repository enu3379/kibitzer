from __future__ import annotations

from datetime import datetime, timezone

from ..config import ControllerConfig
from ..schemas import Verdict
from ..storage.sqlite import (
    ObservationRecord,
    PageLabelRecord,
    SQLiteStore,
    effective_observation_verdict,
)
from .controller_flow import rebuild_controller_state


def apply_page_label_override(
    store: SQLiteStore,
    controller_config: ControllerConfig,
    observation: ObservationRecord,
    label: str,
    exemplar_cap: int,
    now: datetime | None = None,
) -> tuple[PageLabelRecord, int | None, str | None]:
    """Persist a user page fact and rebuild every derived state it affects."""

    applied_at = now or datetime.now(timezone.utc)
    previous_label = store.page_label_for_observation(observation.id)
    page_label, exemplar_count = store.record_page_label(
        session_id=observation.session_id,
        observation_id=observation.id,
        label=label,
        exemplar_cap=exemplar_cap,
        ts=applied_at,
    )
    verdict = effective_observation_verdict(observation.verdict, label)

    if previous_label != label:
        rebuild_controller_state(
            store,
            controller_config,
            observation.session_id,
            now=applied_at,
        )

    if label == "related":
        store.note_attachment_observation(
            observation.session_id,
            Verdict.OK.value,
            applied_at,
            drift_confirmed=False,
        )
        store.resolve_unhandled_interventions_for_observation(
            observation.session_id,
            observation.id,
            ts=applied_at,
        )

    return page_label, exemplar_count, verdict

from __future__ import annotations

import csv
import json
import math
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from ..config import AppConfig
from ..core.controller_flow import apply_controller, confirm_controller_intervention
from ..core.normalization import strip_repeated_title_suffix
from ..core.relevance import tier0_score_parts, tier1_final_relevance
from ..providers.embeddings.factory import create_embedding_provider
from ..schemas import Observation, ObservationFeatures, PipelineAction, Source, Verdict
from ..storage.sqlite import ControllerStateRecord


COUNTERFACTUAL_CAVEAT = (
    "Counterfactual caveat: user actions (feedback clicks and page labels) are "
    "replayed as ground truth at their original timestamps even where the "
    "counterfactual verdict would have differed. Detection-layer metrics are "
    "reliable; intervention counts are indicative."
)


@dataclass(frozen=True)
class ConfigOverride:
    path: str
    value: Any
    raw: str


@dataclass(frozen=True)
class ReplaySessionInfo:
    id: str
    created_at: datetime
    ended_at: datetime | None
    active: bool
    goal: str | None
    observation_count: int


@dataclass(frozen=True)
class StoredObservation:
    id: str
    session_id: str
    ts: datetime
    source: str
    url_host: str | None
    url_path_hash: str | None
    title: str | None
    tab_id: int | None
    features: dict[str, Any]
    verdict: str | None
    tier_reached: int | None
    tier1_reason: str | None


@dataclass(frozen=True)
class EventRecord:
    id: int
    ts: datetime
    event_type: str
    payload: dict[str, Any]


@dataclass
class ReplayRow:
    observation_id: str
    ts: datetime
    url_host: str | None
    title: str | None
    r0_orig: float | None
    r0_replay: float | None = None
    exemplar_score_replay: float | None = None
    derived_score_replay: float | None = None
    anchor_score_replay: float | None = None
    anchor_eligible_orig: bool | None = None
    anchor_eligible_replay: bool | None = None
    verdict_orig: str | None = None
    verdict_replay: str | None = None
    tier_orig: int | None = None
    tier_replay: int | None = None
    tier1_reason: str | None = None
    page_label: str | None = None
    hand_label: str = ""
    title_quality: str = ""
    flags: list[str] = field(default_factory=list)
    tier1_would_call: bool = False
    tier1_no_recording: bool = False
    request_excerpt_replay: bool = False
    skipped_no_goal: bool = False
    embedding_replay: list[float] | None = field(default=None, repr=False)

    @property
    def changed(self) -> bool:
        if self.skipped_no_goal:
            return self.verdict_orig is not None
        if self.verdict_orig != self.verdict_replay:
            return True
        if self.tier_orig != self.tier_replay:
            return True
        if self.tier1_no_recording:
            return True
        if _float_changed(self.r0_orig, self.r0_replay):
            return True
        if self.anchor_eligible_orig is not None and self.anchor_eligible_orig != self.anchor_eligible_replay:
            return True
        return False


@dataclass(frozen=True)
class ReplayResult:
    session: ReplaySessionInfo
    rows: list[ReplayRow]
    summary: dict[str, Any]
    overrides: list[ConfigOverride]


class InMemoryControllerStore:
    def __init__(self, session_id: str, created_at: datetime) -> None:
        self.state = ControllerStateRecord(
            session_id=session_id,
            streak=0,
            obs_count=0,
            last_intervention_ts=None,
            snoozed_until=None,
            alignment_score=None,
            drift_latched=False,
            updated_at=created_at,
        )
        self.request_excerpt_observation_ids: list[str] = []

    def get_controller_state(self, session_id: str) -> ControllerStateRecord:
        if session_id != self.state.session_id:
            raise ValueError("unknown replay session")
        return self.state

    def save_controller_state(
        self,
        session_id: str,
        streak: int,
        obs_count: int,
        last_intervention_ts: datetime | None,
        snoozed_until: datetime | None,
        alignment_score: float | None = None,
        drift_latched: bool = False,
        ts: datetime | None = None,
    ) -> ControllerStateRecord:
        now = ts or datetime.now(timezone.utc)
        self.state = ControllerStateRecord(
            session_id=session_id,
            streak=streak,
            obs_count=obs_count,
            last_intervention_ts=last_intervention_ts,
            snoozed_until=snoozed_until,
            alignment_score=alignment_score,
            drift_latched=drift_latched,
            updated_at=now,
        )
        return self.state

    def record_intervention_requested(
        self,
        session_id: str,
        observation_id: str,
        ts: datetime | None = None,
    ) -> None:
        if session_id != self.state.session_id:
            raise ValueError("unknown replay session")
        self.request_excerpt_observation_ids.append(observation_id)

    def apply_snooze(self, snoozed_until: datetime, ts: datetime) -> None:
        self.state = ControllerStateRecord(
            session_id=self.state.session_id,
            streak=self.state.streak,
            obs_count=self.state.obs_count,
            last_intervention_ts=self.state.last_intervention_ts,
            snoozed_until=snoozed_until,
            alignment_score=self.state.alignment_score,
            drift_latched=self.state.drift_latched,
            updated_at=ts,
        )


class ReplayState:
    def __init__(self, session: ReplaySessionInfo, config: AppConfig) -> None:
        self.session = session
        self.config = config
        self.goal_text: str | None = None
        self.exemplars: list[list[float]] = []
        self.exemplar_observation_ids: list[str | None] = []
        self.derived_phrases: list[str] = []
        self.derived_vectors: list[list[float]] = []
        self.ok_embeddings: list[list[float]] = []
        self.rows: list[ReplayRow] = []
        self.rows_by_observation_id: dict[str, ReplayRow] = {}
        self.controller_store = InMemoryControllerStore(session.id, session.created_at)

    def reset_goal(self, raw_text: str, exemplar: list[float]) -> None:
        self.goal_text = raw_text
        self.exemplars = [exemplar]
        self.exemplar_observation_ids = [None]
        self.derived_phrases = []
        self.derived_vectors = []

    def set_derived_phrases(self, phrases: list[str], vectors: list[list[float]]) -> None:
        self.derived_phrases = phrases[: self.config.goal_enrichment.max_phrases]
        self.derived_vectors = vectors[: self.config.goal_enrichment.max_phrases]

    def add_exemplar(self, observation_id: str) -> bool:
        if observation_id in self.exemplar_observation_ids:
            return False
        row = self.rows_by_observation_id.get(observation_id)
        if not row or not row.embedding_replay:
            return False
        self.exemplars.append(row.embedding_replay)
        self.exemplar_observation_ids.append(observation_id)
        self._enforce_exemplar_cap(max(1, self.config.relevance.exemplar_cap))
        return True

    def remove_exemplar(self, observation_id: str) -> bool:
        try:
            index = self.exemplar_observation_ids.index(observation_id)
        except ValueError:
            return False
        del self.exemplars[index]
        del self.exemplar_observation_ids[index]
        return True

    def anchor_value(self) -> list[float] | None:
        window = self.config.relevance.anchor_window
        if window <= 0:
            return None
        embeddings = self.ok_embeddings[-window:]
        if not embeddings:
            return None
        width = len(embeddings[0])
        sums = [0.0] * width
        for emb in embeddings:
            for index, value in enumerate(emb):
                sums[index] += value
        return [value / len(embeddings) for value in sums]

    def admit_anchor(self, emb: list[float], verdict: Verdict, anchor_eligible: bool | None) -> None:
        if verdict == Verdict.OK and anchor_eligible is not False:
            self.ok_embeddings.append(emb)

    def _enforce_exemplar_cap(self, cap: int) -> None:
        excess = len(self.exemplars) - cap
        if excess <= 0:
            return
        if len(self.exemplars) - 1 >= excess:
            del self.exemplars[1 : 1 + excess]
            del self.exemplar_observation_ids[1 : 1 + excess]
        else:
            del self.exemplars[:excess]
            del self.exemplar_observation_ids[:excess]


async def replay_session(
    db_path: str | Path,
    *,
    session: str | None = None,
    latest: bool = False,
    config: AppConfig,
    overrides: list[ConfigOverride] | None = None,
    derived_phrases_path: str | Path | None = None,
) -> ReplayResult:
    with _connect_readonly(db_path) as conn:
        session_id = resolve_session_id(conn, session=session, latest=latest)
        session_info = _read_session_info(conn, session_id)
        observations = _read_observations(conn, session_id)
        events = _read_events(conn, session_id)
        page_labels = _read_page_labels(conn, session_id)
        goal_fallback = _read_goal_fallback(conn, session_id)
        original_request_excerpt = sum(1 for event in events if event.event_type == "intervention.request_excerpt")
        injected_phrases = _injected_phrases_for_session(
            load_derived_phrase_injections(derived_phrases_path),
            session_id,
        )

        embedding_provider = create_embedding_provider(config.embedding)
        state = ReplayState(session_info, config)

        if goal_fallback and not any(event.event_type == "goal.declared" for event in events):
            vector = (await embedding_provider.embed([goal_fallback]))[0]
            state.reset_goal(goal_fallback, vector)
            await _apply_injected_derived_phrases(state, embedding_provider, injected_phrases)

        processed_observations: set[str] = set()
        for event in events:
            if event.event_type == "goal.declared":
                raw_text = str(event.payload.get("raw_text") or "").strip()
                if raw_text:
                    vector = (await embedding_provider.embed([raw_text]))[0]
                    state.reset_goal(raw_text, vector)
                    await _apply_injected_derived_phrases(state, embedding_provider, injected_phrases)
                continue
            if event.event_type == "goal.enriched":
                phrases = _phrases_from_event(event.payload.get("phrases"))
                vectors = await embedding_provider.embed(phrases) if phrases else []
                state.set_derived_phrases(phrases, vectors)
                continue
            if event.event_type == "goal.exemplar_added":
                observation_id = event.payload.get("observation_id")
                if isinstance(observation_id, str):
                    state.add_exemplar(observation_id)
                continue
            if event.event_type == "page_label.recorded":
                observation_id = event.payload.get("observation_id")
                if isinstance(observation_id, str) and event.payload.get("label") == "drift":
                    state.remove_exemplar(observation_id)
                continue
            if event.event_type == "session.snoozed":
                snoozed_until = _parse_dt_optional(event.payload.get("snoozed_until"))
                if snoozed_until:
                    state.controller_store.apply_snooze(snoozed_until, event.ts)
                continue
            if event.event_type != "observation.recorded":
                continue

            observation_id = event.payload.get("observation_id")
            if not isinstance(observation_id, str) or observation_id not in observations:
                continue
            await _replay_observation(
                conn,
                observations[observation_id],
                page_labels.get(observation_id),
                state,
                embedding_provider,
            )
            processed_observations.add(observation_id)

        for observation in sorted(
            (item for item in observations.values() if item.id not in processed_observations),
            key=lambda item: (item.ts, item.id),
        ):
            await _replay_observation(
                conn,
                observation,
                page_labels.get(observation.id),
                state,
                embedding_provider,
            )

    summary = _build_summary(state.rows, original_request_excerpt)
    return ReplayResult(
        session=session_info,
        rows=state.rows,
        summary=summary,
        overrides=overrides or [],
    )


def list_sessions(db_path: str | Path) -> list[ReplaySessionInfo]:
    with _connect_readonly(db_path) as conn:
        rows = conn.execute(
            """
            SELECT sessions.id, sessions.created_at, sessions.ended_at, sessions.active,
                   goals.raw_text AS goal, COUNT(observations.id) AS observation_count
            FROM sessions
            LEFT JOIN goals ON goals.session_id = sessions.id
            LEFT JOIN observations ON observations.session_id = sessions.id
            GROUP BY sessions.id, sessions.created_at, sessions.ended_at, sessions.active, goals.raw_text
            ORDER BY sessions.created_at DESC, sessions.id DESC
            """
        ).fetchall()
    return [
        ReplaySessionInfo(
            id=row["id"],
            created_at=_parse_dt(row["created_at"]),
            ended_at=_parse_dt(row["ended_at"]) if row["ended_at"] else None,
            active=bool(row["active"]),
            goal=row["goal"],
            observation_count=int(row["observation_count"]),
        )
        for row in rows
    ]


def resolve_session_id(conn: sqlite3.Connection, *, session: str | None, latest: bool) -> str:
    if latest:
        row = conn.execute(
            """
            SELECT sessions.id
            FROM sessions
            JOIN goals ON goals.session_id = sessions.id
            WHERE sessions.ended_at IS NOT NULL
            ORDER BY sessions.ended_at DESC, sessions.created_at DESC, sessions.id DESC
            LIMIT 1
            """
        ).fetchone()
        if not row:
            raise ValueError("no ended session with a goal found")
        return str(row["id"])

    if not session:
        raise ValueError("provide --session or --latest")

    exact = conn.execute("SELECT id FROM sessions WHERE id = ?", (session,)).fetchone()
    if exact:
        return str(exact["id"])

    rows = conn.execute(
        "SELECT id FROM sessions WHERE id LIKE ? ORDER BY created_at DESC, id DESC",
        (f"{session}%",),
    ).fetchall()
    if not rows:
        raise ValueError(f"session not found: {session}")
    if len(rows) > 1:
        matches = ", ".join(str(row["id"]) for row in rows[:5])
        raise ValueError(f"session prefix is ambiguous: {session} ({matches})")
    return str(rows[0]["id"])


def apply_config_overrides(config: AppConfig, override_items: list[str]) -> tuple[AppConfig, list[ConfigOverride]]:
    data = config.model_dump(mode="python", by_alias=True)
    data.pop("raw", None)
    parsed: list[ConfigOverride] = []

    for item in override_items:
        if "=" not in item:
            raise ValueError(f"override must be dotted.path=value: {item}")
        path, raw_value = item.split("=", 1)
        value = yaml.safe_load(raw_value)
        _set_dotted(data, path, value)
        parsed.append(ConfigOverride(path=path, value=value, raw=item))

    return AppConfig(raw=config.raw, **data), parsed


def write_csv(path: str | Path, result: ReplayResult) -> None:
    fieldnames = [
        "ts",
        "url_host",
        "title",
        "r0_orig",
        "r0_replay",
        "exemplar_score_replay",
        "derived_score_replay",
        "anchor_score_replay",
        "anchor_eligible_replay",
        "verdict_orig",
        "verdict_replay",
        "tier_orig",
        "tier_replay",
        "tier1_reason",
        "page_label",
        "hand_label",
        "title_quality",
    ]
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in result.rows:
            writer.writerow({key: _csv_row(row)[key] for key in fieldnames})


def write_json(path: str | Path, result: ReplayResult) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "session": {
            "id": result.session.id,
            "created_at": result.session.created_at.isoformat(),
            "ended_at": result.session.ended_at.isoformat() if result.session.ended_at else None,
            "active": result.session.active,
            "goal": result.session.goal,
            "observation_count": result.session.observation_count,
        },
        "overrides": [override.raw for override in result.overrides],
        "rows": [_json_row(row) for row in result.rows],
        "summary": result.summary,
        "caveat": COUNTERFACTUAL_CAVEAT,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def format_report(result: ReplayResult, *, full: bool = False) -> str:
    lines = [
        f"Replay session: {result.session.id}",
        f"Goal: {result.session.goal or '(none)'}",
        f"Observations: {result.session.observation_count}",
    ]
    if result.overrides:
        lines.append("Overrides: " + ", ".join(override.raw for override in result.overrides))
    else:
        lines.append("Overrides: (none)")
    if result.summary["skipped_no_goal"]:
        lines.append(f"Skipped pre-goal observations: {result.summary['skipped_no_goal']}")
    lines.append("")
    lines.append("Changed observations" if not full else "Observations")
    lines.append("ts | host | title | r0 orig->replay | verdict orig->replay | tier orig->replay | flags")

    selected = result.rows if full else [row for row in result.rows if row.changed]
    if not selected:
        lines.append("(no changed rows; use --full to print every observation)")
    for row in selected:
        lines.append(
            " | ".join(
                [
                    row.ts.isoformat(),
                    _truncate(row.url_host or "", 28),
                    _truncate(row.title or "", 48),
                    f"{_fmt_float(row.r0_orig)}->{_fmt_float(row.r0_replay)}",
                    f"{row.verdict_orig or ''}->{row.verdict_replay or ''}",
                    f"{_fmt_int(row.tier_orig)}->{_fmt_int(row.tier_replay)}",
                    ",".join(row.flags) if row.flags else "-",
                ]
            )
        )

    summary = result.summary
    lines.extend(
        [
            "",
            "Summary",
            f"Verdict flips OK->DRIFT: {summary['flips']['OK->DRIFT']}",
            f"Verdict flips DRIFT->OK: {summary['flips']['DRIFT->OK']}",
            f"Verdict unchanged: {summary['unchanged_verdicts']}",
            (
                "Tier 1 calls original/replay/no-recording: "
                f"{summary['tier1']['original_calls']}/"
                f"{summary['tier1']['replay_would_call']}/"
                f"{summary['tier1']['no_recording']}"
            ),
            (
                "request_excerpt original/replay: "
                f"{summary['request_excerpt']['original']}/{summary['request_excerpt']['replay']}"
            ),
            (
                "Label errors false-OK/false-DRIFT: "
                f"{summary['labels']['false_ok']}/{summary['labels']['false_drift']}"
            ),
            "",
            "r0 histogram by replayed verdict",
        ]
    )
    lines.extend(_format_histogram(summary["histograms"]["by_verdict"]))
    if summary["histograms"]["by_verdict_label"]:
        lines.append("")
        lines.append("r0 histogram by replayed verdict x page label")
        lines.extend(_format_histogram(summary["histograms"]["by_verdict_label"]))
    lines.extend(["", COUNTERFACTUAL_CAVEAT])
    return "\n".join(lines)


async def _replay_observation(
    conn: sqlite3.Connection,
    stored: StoredObservation,
    page_label: str | None,
    state: ReplayState,
    embedding_provider,
) -> None:
    tier_orig = _tier_orig(stored)
    row = ReplayRow(
        observation_id=stored.id,
        ts=stored.ts,
        url_host=stored.url_host,
        title=stored.title,
        r0_orig=_float_or_none(stored.features.get("r0")),
        anchor_eligible_orig=_bool_or_none(stored.features.get("anchor_eligible")),
        verdict_orig=stored.verdict,
        tier_orig=tier_orig,
        tier1_reason=stored.tier1_reason,
        page_label=page_label,
    )

    if not state.goal_text or not state.exemplars:
        row.skipped_no_goal = True
        state.rows.append(row)
        state.rows_by_observation_id[row.observation_id] = row
        return

    previous_titles = _recent_titles_for_host(
        conn,
        stored.url_host or "",
        before_ts=stored.ts,
        before_id=stored.id,
    )
    embedding_text = strip_repeated_title_suffix((stored.title or "").strip(), previous_titles)
    emb = (await embedding_provider.embed([embedding_text]))[0]
    score = tier0_score_parts(
        emb=emb,
        exemplars=state.exemplars,
        anchor=state.anchor_value(),
        beta=state.config.relevance.beta,
        derived_exemplars=state.derived_vectors,
        derived_tau=state.config.goal_enrichment.derived_tau,
    )
    tier0_verdict = Verdict.OK if score.score >= state.config.relevance.tau_ok else Verdict.DRIFT
    verdict_replay = tier0_verdict
    tier_replay = 0

    if tier0_verdict == Verdict.DRIFT and state.config.tier1.enabled:
        row.tier1_would_call = True
        if tier_orig is not None and tier_orig >= 1 and stored.verdict in {Verdict.OK.value, Verdict.DRIFT.value}:
            verdict_replay = Verdict(stored.verdict)
            tier_replay = 1
        else:
            row.tier1_no_recording = True
            row.flags.append("tier1:no_recording")

    final_relevance = tier1_final_relevance(verdict_replay) if tier_replay >= 1 else score.score

    anchor_eligible = (
        score.exemplar_score >= state.config.relevance.anchor_epsilon
        or score.derived_score >= state.config.goal_enrichment.derived_tau
        or (verdict_replay == Verdict.OK and tier_replay >= 1)
    )

    row.r0_replay = score.score
    row.exemplar_score_replay = score.exemplar_score
    row.derived_score_replay = score.derived_score
    row.anchor_score_replay = score.anchor_score
    row.anchor_eligible_replay = anchor_eligible
    row.verdict_replay = verdict_replay.value
    row.tier_replay = tier_replay
    row.embedding_replay = emb

    if row.verdict_orig and row.verdict_orig != row.verdict_replay:
        row.flags.append("flip")
    if verdict_replay == Verdict.OK:
        row.flags.append("anchor:admitted" if anchor_eligible else "anchor:blocked")

    observation = Observation(
        id=stored.id,
        ts=stored.ts,
        session_id=stored.session_id,
        source=Source.BROWSER_NAV,
        payload={
            "url_host": stored.url_host,
            "url_path_hash": stored.url_path_hash,
            "title": stored.title,
            "tab_id": stored.tab_id,
        },
        features=ObservationFeatures(
            emb=emb,
            r0=score.score,
            r_final=final_relevance,
            tier_reached=tier_replay,
            exemplar_score=score.exemplar_score,
            derived_score=score.derived_score,
            anchor_eligible=anchor_eligible,
        ),
        verdict=verdict_replay,
        tier1_reason=stored.tier1_reason if tier_replay >= 1 else None,
    )
    result = apply_controller(
        state.controller_store,
        state.config.controller,
        observation,
        now=stored.ts,
    )
    row.request_excerpt_replay = result.action == PipelineAction.REQUEST_EXCERPT
    if row.request_excerpt_replay:
        # Replay has no page excerpt or live Tier 2 result. Preserve its existing
        # "would request" intervention cadence by treating each replayed request
        # as confirmed after recording the candidate point.
        state.controller_store.record_intervention_requested(
            observation.session_id,
            observation.id,
            ts=stored.ts,
        )
        confirm_controller_intervention(
            state.controller_store,
            state.config.controller,
            observation.session_id,
            now=stored.ts,
        )
    state.admit_anchor(emb, verdict_replay, anchor_eligible)
    state.rows.append(row)
    state.rows_by_observation_id[row.observation_id] = row


@contextmanager
def _connect_readonly(db_path: str | Path) -> Iterator[sqlite3.Connection]:
    path = Path(db_path)
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _read_session_info(conn: sqlite3.Connection, session_id: str) -> ReplaySessionInfo:
    row = conn.execute(
        """
        SELECT sessions.id, sessions.created_at, sessions.ended_at, sessions.active,
               goals.raw_text AS goal,
               (SELECT COUNT(*) FROM observations WHERE observations.session_id = sessions.id) AS observation_count
        FROM sessions
        LEFT JOIN goals ON goals.session_id = sessions.id
        WHERE sessions.id = ?
        """,
        (session_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"session not found: {session_id}")
    return ReplaySessionInfo(
        id=row["id"],
        created_at=_parse_dt(row["created_at"]),
        ended_at=_parse_dt(row["ended_at"]) if row["ended_at"] else None,
        active=bool(row["active"]),
        goal=row["goal"],
        observation_count=int(row["observation_count"]),
    )


def _read_goal_fallback(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute("SELECT raw_text FROM goals WHERE session_id = ?", (session_id,)).fetchone()
    if not row or row["raw_text"] is None:
        return None
    return str(row["raw_text"])


def _read_observations(conn: sqlite3.Connection, session_id: str) -> dict[str, StoredObservation]:
    columns = _columns(conn, "observations")
    tier1_expr = "tier1_reason" if "tier1_reason" in columns else "NULL AS tier1_reason"
    rows = conn.execute(
        f"""
        SELECT id, session_id, ts, source, url_host, url_path_hash, title, tab_id,
               features_json, verdict, tier_reached, {tier1_expr}
        FROM observations
        WHERE session_id = ?
        ORDER BY ts ASC, id ASC
        """,
        (session_id,),
    ).fetchall()
    observations: dict[str, StoredObservation] = {}
    for row in rows:
        observations[row["id"]] = StoredObservation(
            id=row["id"],
            session_id=row["session_id"],
            ts=_parse_dt(row["ts"]),
            source=row["source"],
            url_host=row["url_host"],
            url_path_hash=row["url_path_hash"],
            title=row["title"],
            tab_id=row["tab_id"],
            features=_json_dict(row["features_json"]),
            verdict=row["verdict"],
            tier_reached=row["tier_reached"],
            tier1_reason=row["tier1_reason"],
        )
    return observations


def _read_events(conn: sqlite3.Connection, session_id: str) -> list[EventRecord]:
    if not _table_exists(conn, "event_log"):
        return []
    rows = conn.execute(
        """
        SELECT id, ts, event_type, payload_json
        FROM event_log
        WHERE session_id = ?
        ORDER BY ts ASC, id ASC
        """,
        (session_id,),
    ).fetchall()
    return [
        EventRecord(
            id=int(row["id"]),
            ts=_parse_dt(row["ts"]),
            event_type=row["event_type"],
            payload=_json_dict(row["payload_json"]),
        )
        for row in rows
    ]


def _read_page_labels(conn: sqlite3.Connection, session_id: str) -> dict[str, str]:
    if not _table_exists(conn, "page_labels"):
        return {}
    rows = conn.execute(
        """
        SELECT page_labels.observation_id, page_labels.label
        FROM page_labels
        JOIN observations ON observations.id = page_labels.observation_id
        WHERE observations.session_id = ?
        """,
        (session_id,),
    ).fetchall()
    return {row["observation_id"]: row["label"] for row in rows}


def load_derived_phrase_injections(path: str | Path | None) -> dict[str, list[str]]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    goals = payload.get("goals") if isinstance(payload, dict) else None
    if not isinstance(goals, dict):
        raise ValueError("derived phrases file must contain goals")
    injections: dict[str, list[str]] = {}
    for session_id, value in goals.items():
        if not isinstance(session_id, str):
            continue
        phrases = value.get("phrases") if isinstance(value, dict) else None
        if not isinstance(phrases, list):
            continue
        injections[session_id] = [phrase for phrase in phrases if isinstance(phrase, str)]
    return injections


def _injected_phrases_for_session(injections: dict[str, list[str]], session_id: str) -> list[str]:
    if session_id in injections:
        return injections[session_id]
    matches = [
        phrases
        for key, phrases in injections.items()
        if session_id.startswith(key) or key.startswith(session_id)
    ]
    return matches[0] if len(matches) == 1 else []


async def _apply_injected_derived_phrases(
    state: ReplayState,
    embedding_provider,
    phrases: list[str],
) -> None:
    if not phrases:
        return
    capped = phrases[: state.config.goal_enrichment.max_phrases]
    vectors = await embedding_provider.embed(capped)
    state.set_derived_phrases(capped, vectors)


def _phrases_from_event(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _recent_titles_for_host(
    conn: sqlite3.Connection,
    url_host: str,
    *,
    before_ts: datetime,
    before_id: str,
    limit: int = 10,
) -> list[str]:
    if not url_host:
        return []
    rows = conn.execute(
        """
        SELECT title
        FROM observations
        WHERE url_host = ?
          AND title IS NOT NULL
          AND title != ''
          AND (ts < ? OR (ts = ? AND id < ?))
        ORDER BY ts DESC, id DESC
        LIMIT ?
        """,
        (url_host, before_ts.isoformat(), before_ts.isoformat(), before_id, limit),
    ).fetchall()
    return [row["title"] for row in rows]


def _build_summary(rows: list[ReplayRow], original_request_excerpt: int) -> dict[str, Any]:
    scored = [row for row in rows if not row.skipped_no_goal and row.verdict_replay is not None]
    flips = {"OK->DRIFT": 0, "DRIFT->OK": 0}
    unchanged = 0
    false_ok = 0
    false_drift = 0
    for row in scored:
        if row.verdict_orig == row.verdict_replay:
            unchanged += 1
        elif row.verdict_orig == "OK" and row.verdict_replay == "DRIFT":
            flips["OK->DRIFT"] += 1
        elif row.verdict_orig == "DRIFT" and row.verdict_replay == "OK":
            flips["DRIFT->OK"] += 1
        if row.page_label == "drift" and row.verdict_replay == "OK":
            false_ok += 1
        if row.page_label == "related" and row.verdict_replay == "DRIFT":
            false_drift += 1

    return {
        "observations": len(rows),
        "scored": len(scored),
        "skipped_no_goal": sum(1 for row in rows if row.skipped_no_goal),
        "flips": flips,
        "unchanged_verdicts": unchanged,
        "tier1": {
            "original_calls": sum(1 for row in rows if row.tier_orig is not None and row.tier_orig >= 1),
            "replay_would_call": sum(1 for row in rows if row.tier1_would_call),
            "no_recording": sum(1 for row in rows if row.tier1_no_recording),
        },
        "request_excerpt": {
            "original": original_request_excerpt,
            "replay": sum(1 for row in rows if row.request_excerpt_replay),
        },
        "labels": {
            "false_ok": false_ok,
            "false_drift": false_drift,
        },
        "histograms": {
            "by_verdict": _histogram(scored, lambda row: row.verdict_replay or ""),
            "by_verdict_label": _histogram(
                [row for row in scored if row.page_label],
                lambda row: f"{row.verdict_replay}|{row.page_label}",
            ),
        },
    }


def _histogram(rows: list[ReplayRow], key_fn) -> dict[str, dict[str, int]]:
    histogram: dict[str, dict[str, int]] = {}
    for row in rows:
        if row.r0_replay is None:
            continue
        key = key_fn(row)
        bucket = _bucket(row.r0_replay)
        values = histogram.setdefault(key, {})
        values[bucket] = values.get(bucket, 0) + 1
    return {
        key: dict(sorted(values.items()))
        for key, values in sorted(histogram.items())
    }


def _format_histogram(histogram: dict[str, dict[str, int]]) -> list[str]:
    if not histogram:
        return ["(empty)"]
    lines: list[str] = []
    for key, buckets in histogram.items():
        parts = [f"{bucket}:{count}" for bucket, count in buckets.items()]
        lines.append(f"{key}: " + " ".join(parts))
    return lines


def _bucket(value: float) -> str:
    start = math.floor(value / 0.05) * 0.05
    end = start + 0.05
    return f"{start:.2f}-{end:.2f}"


def _csv_row(row: ReplayRow) -> dict[str, Any]:
    return {
        "ts": row.ts.isoformat(),
        "url_host": row.url_host or "",
        "title": row.title or "",
        "r0_orig": _fmt_float(row.r0_orig),
        "r0_replay": _fmt_float(row.r0_replay),
        "exemplar_score_replay": _fmt_float(row.exemplar_score_replay),
        "derived_score_replay": _fmt_float(row.derived_score_replay),
        "anchor_score_replay": _fmt_float(row.anchor_score_replay),
        "anchor_eligible_replay": "" if row.anchor_eligible_replay is None else str(row.anchor_eligible_replay).lower(),
        "verdict_orig": row.verdict_orig or "",
        "verdict_replay": row.verdict_replay or "",
        "tier_orig": _fmt_int(row.tier_orig),
        "tier_replay": _fmt_int(row.tier_replay),
        "tier1_reason": row.tier1_reason or "",
        "page_label": row.page_label or "",
        "hand_label": row.hand_label,
        "title_quality": row.title_quality,
    }


def _json_row(row: ReplayRow) -> dict[str, Any]:
    payload = _csv_row(row)
    payload.update(
        {
            "observation_id": row.observation_id,
            "anchor_eligible_orig": row.anchor_eligible_orig,
            "flags": row.flags,
            "tier1_would_call": row.tier1_would_call,
            "tier1_no_recording": row.tier1_no_recording,
            "request_excerpt_replay": row.request_excerpt_replay,
            "skipped_no_goal": row.skipped_no_goal,
            "changed": row.changed,
        }
    )
    return payload


def _set_dotted(data: dict[str, Any], path: str, value: Any) -> None:
    keys = path.split(".")
    target: Any = data
    for key in keys[:-1]:
        if not isinstance(target, dict) or key not in target:
            raise ValueError(f"unknown override path: {path}")
        target = target[key]
    final = keys[-1]
    if not isinstance(target, dict) or final not in target:
        raise ValueError(f"unknown override path: {path}")
    target[final] = value


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _json_dict(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_dt(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _parse_dt_optional(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _parse_dt(value)
    except ValueError:
        return None


def _tier_orig(stored: StoredObservation) -> int | None:
    if stored.tier_reached is not None:
        return int(stored.tier_reached)
    value = stored.features.get("tier_reached")
    return int(value) if isinstance(value, int) else None


def _float_or_none(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _bool_or_none(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _float_changed(left: float | None, right: float | None, tolerance: float = 1e-9) -> bool:
    if left is None or right is None:
        return left != right
    return abs(left - right) > tolerance


def _fmt_float(value: float | None) -> str:
    return "" if value is None else f"{value:.6f}"


def _fmt_int(value: int | None) -> str:
    return "" if value is None else str(value)


def _truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 3)] + "..."

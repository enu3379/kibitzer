from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from ..schemas import Observation


# Pending expiry and abandoned-work recovery are intentionally separate clocks.
INTERVENTION_CANDIDATE_IN_FLIGHT_STALE_AFTER = timedelta(minutes=15)


def effective_observation_verdict(verdict: str | None, label: str | None) -> str | None:
    """Return the product verdict after applying the user's page-fact label."""
    if label == "related":
        return "OK"
    if label == "drift":
        return "DRIFT"
    return verdict


class NoActiveSessionError(RuntimeError):
    pass


class IdempotencyConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class SessionRecord:
    id: str
    created_at: datetime
    active: bool


@dataclass(frozen=True)
class GoalDerivedExemplarRecord:
    phrase: str
    vector: list[float]
    position: int


@dataclass(frozen=True)
class GoalRecord:
    session_id: str
    raw_text: str
    exemplars: list[list[float]]
    provenance: str
    updated_at: datetime
    goal_revision: int
    available_time_minutes: int | None = None
    derived_exemplars: list[GoalDerivedExemplarRecord] = field(default_factory=list)

    @property
    def derived_phrases(self) -> list[str]:
        return [item.phrase for item in self.derived_exemplars]

    @property
    def derived_vectors(self) -> list[list[float]]:
        return [item.vector for item in self.derived_exemplars]


@dataclass(frozen=True)
class CurrentSessionRecord:
    session: SessionRecord
    goal: GoalRecord | None


@dataclass(frozen=True)
class ObservationRecord:
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
    tier1_reason: str | None = None
    goal_revision: int | None = None


@dataclass(frozen=True)
class PageLabelRecord:
    id: str
    observation_id: str
    label: str
    ts: datetime


@dataclass(frozen=True)
class ObservationSummary:
    title: str | None
    verdict: str | None


@dataclass(frozen=True)
class ObservationExcerptRecord:
    observation_id: str
    session_id: str
    captured_at: datetime
    text: str
    char_count: int


@dataclass(frozen=True)
class ObservationContentSummary:
    observation_id: str
    title: str | None
    verdict: str | None
    text: str


@dataclass(frozen=True)
class ControllerStateRecord:
    session_id: str
    streak: int
    obs_count: int
    last_intervention_ts: datetime | None
    snoozed_until: datetime | None
    alignment_score: float | None
    drift_latched: bool
    updated_at: datetime


@dataclass(frozen=True)
class ControllerReplayEvent:
    kind: str
    ts: datetime
    observation_id: str | None = None
    verdict: str | None = None
    r_final: float | None = None
    label: str | None = None


@dataclass(frozen=True)
class DriftClockStateRecord:
    session_id: str
    active_observation_id: str | None
    active_tab_id: int | None
    active_url_host: str | None
    active_url_path_hash: str | None
    active_verdict: str | None
    active_since_at: datetime | None
    last_heartbeat_at: datetime | None
    current_page_drift_seconds: int
    continuous_drift_seconds: int
    cumulative_drift_seconds: int
    next_review_mode_seconds: int
    review_observation_id: str | None
    review_started_at: datetime | None
    review_status: str
    last_defer_reason: str | None
    updated_at: datetime


@dataclass(frozen=True)
class PreparedD7ReviewRecord:
    session_id: str
    observation_id: str
    goal_revision: int
    deliver_after: datetime
    outcome: dict[str, Any] | None
    prepared_at: datetime | None


@dataclass(frozen=True)
class InterventionRecord:
    id: str
    session_id: str
    observation_id: str | None
    ts: datetime
    message: str
    status: str
    tier1_reason: str | None = None


@dataclass(frozen=True)
class InterventionCandidateRecord:
    id: str
    session_id: str
    observation_id: str
    goal_revision: int
    status: str
    requested_at: datetime
    expires_at: datetime
    updated_at: datetime
    intervention_id: str | None = None
    terminal_result: dict[str, Any] | None = None


@dataclass(frozen=True)
class ObservationRequestRecord:
    idempotency_key: str
    request_fingerprint: str
    result: dict[str, Any] | None


@dataclass(frozen=True)
class ObservationProcessingStateRecord:
    observation_id: str
    session_id: str
    goal_revision: int
    tab_id: int | None
    url_host: str | None
    url_path_hash: str | None
    title: str | None
    stage: str
    started_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SessionStatsRecord:
    session_id: str
    started_at: datetime
    ended_at: datetime | None
    duration_seconds: int
    observations: int
    ok: int
    drift: int
    unjudged: int
    related_ratio: float | None
    interventions: int
    interventions_accepted: int
    top_drift_host: str | None
    top_drift_count: int


@dataclass(frozen=True)
class ReturnCandidateRecord:
    drift_started_at: datetime
    drift_confirmed_at: datetime
    last_celebration_ts: datetime | None
    last_celebration_template: str | None


@dataclass(frozen=True)
class ReportHourBucketRecord:
    hour: str
    observations: int
    ok: int
    drift: int
    related_ratio: float | None


@dataclass(frozen=True)
class DriftHostRecord:
    host: str
    count: int


@dataclass(frozen=True)
class OkStretchRecord:
    start: datetime
    end: datetime
    minutes: int


@dataclass(frozen=True)
class JudgmentReasonRecord:
    observation_id: str
    ts: datetime
    verdict: str | None
    url_host: str | None
    title: str | None
    tier_reached: int | None
    tier1_reason: str | None


@dataclass(frozen=True)
class SessionReportRecord:
    scope: str
    session_id: str | None
    date: str | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_seconds: int
    observations: int
    ok: int
    drift: int
    unjudged: int
    related_ratio: float | None
    hourly_related_ratio: list[ReportHourBucketRecord] = field(default_factory=list)
    top_drift_hosts: list[DriftHostRecord] = field(default_factory=list)
    longest_ok_stretch: OkStretchRecord | None = None
    intervention_status_counts: dict[str, int] = field(default_factory=dict)
    feedback_counts: dict[str, int] = field(default_factory=dict)
    judgments: list[JudgmentReasonRecord] = field(default_factory=list)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _stretch_seconds(start: datetime, end: datetime | None) -> float:
    return (end - start).total_seconds() if end else 0.0


class SQLiteStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)

    def initialize(self) -> None:
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            self._ensure_schema(conn)

    def delete_all_activity_data(self) -> None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("DELETE FROM observation_requests")
            conn.execute("DELETE FROM sessions")
            conn.execute("DELETE FROM event_log")

    def create_session(self) -> SessionRecord:
        session_id = f"sess_{uuid.uuid4().hex}"
        now = _utc_now()
        now_text = now.isoformat()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute(
                "DELETE FROM observation_excerpts WHERE session_id IN (SELECT id FROM sessions WHERE active = 1)"
            )
            conn.execute(
                "DELETE FROM dwell_presence_events WHERE session_id IN (SELECT id FROM sessions WHERE active = 1)"
            )
            conn.execute(
                "DELETE FROM drift_page_dwell_states WHERE session_id IN (SELECT id FROM sessions WHERE active = 1)"
            )
            conn.execute(
                "DELETE FROM observation_processing_states WHERE session_id IN (SELECT id FROM sessions WHERE active = 1)"
            )
            conn.execute(
                "DELETE FROM d7_prepared_reviews WHERE session_id IN (SELECT id FROM sessions WHERE active = 1)"
            )
            conn.execute("UPDATE sessions SET active = 0, ended_at = ? WHERE active = 1", (now_text,))
            conn.execute(
                "INSERT INTO sessions (id, created_at, active) VALUES (?, ?, 1)",
                (session_id, now_text),
            )
            conn.execute(
                """
                INSERT INTO controller_states (
                    session_id, streak, obs_count, last_intervention_ts, snoozed_until, updated_at
                )
                VALUES (?, 0, 0, NULL, NULL, ?)
                """,
                (session_id, now_text),
            )
            self._append_event(conn, session_id, "session.created", {"active": True}, now)
        return SessionRecord(id=session_id, created_at=now, active=True)

    def get_current_session(self) -> CurrentSessionRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            session_row = conn.execute(
                "SELECT id, created_at, active FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if not session_row:
                return None
            goal_row = conn.execute(
                """
                SELECT session_id, raw_text, provenance, updated_at,
                       available_time_minutes, goal_revision
                FROM goals
                WHERE session_id = ?
                """,
                (session_row["id"],),
            ).fetchone()

        session = SessionRecord(
            id=session_row["id"],
            created_at=_parse_dt(session_row["created_at"]),
            active=bool(session_row["active"]),
        )
        goal = self._goal_from_row(goal_row) if goal_row else None
        return CurrentSessionRecord(session=session, goal=goal)

    def end_current_session(self) -> SessionRecord:
        now = _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT id, created_at FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if not row:
                raise NoActiveSessionError("no active session to end")
            conn.execute(
                "UPDATE sessions SET active = 0, ended_at = ? WHERE id = ?",
                (now.isoformat(), row["id"]),
            )
            conn.execute("DELETE FROM observation_excerpts WHERE session_id = ?", (row["id"],))
            conn.execute("DELETE FROM dwell_presence_events WHERE session_id = ?", (row["id"],))
            conn.execute("DELETE FROM drift_page_dwell_states WHERE session_id = ?", (row["id"],))
            conn.execute("DELETE FROM observation_processing_states WHERE session_id = ?", (row["id"],))
            conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (row["id"],))
            self._append_event(conn, row["id"], "session.ended", {}, now)
        return SessionRecord(id=row["id"], created_at=_parse_dt(row["created_at"]), active=False)

    def session_stats(self, session_id: str) -> SessionStatsRecord:
        with self._connect() as conn:
            self._ensure_schema(conn)
            session_row = conn.execute(
                "SELECT id, created_at, ended_at FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if not session_row:
                raise ValueError("session not found")
            verdict_rows = conn.execute(
                """
                SELECT CASE page_labels.label
                         WHEN 'related' THEN 'OK'
                         WHEN 'drift' THEN 'DRIFT'
                         ELSE observations.verdict
                       END AS verdict,
                       COUNT(*) AS n
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                GROUP BY verdict
                """,
                (session_id,),
            ).fetchall()
            top_drift_row = conn.execute(
                """
                SELECT observations.url_host, COUNT(*) AS n
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                  AND CASE page_labels.label
                        WHEN 'related' THEN 'OK'
                        WHEN 'drift' THEN 'DRIFT'
                        ELSE observations.verdict
                      END = 'DRIFT'
                  AND observations.url_host IS NOT NULL
                GROUP BY observations.url_host
                ORDER BY n DESC, observations.url_host ASC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            intervention_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS n
                FROM interventions
                WHERE session_id = ?
                GROUP BY status
                """,
                (session_id,),
            ).fetchall()

        counts = {row["verdict"]: int(row["n"]) for row in verdict_rows}
        ok = counts.get("OK", 0)
        drift = counts.get("DRIFT", 0)
        total = sum(counts.values())
        judged = ok + drift
        started_at = _parse_dt(session_row["created_at"])
        ended_at = _parse_dt(session_row["ended_at"]) if session_row["ended_at"] else None
        end_bound = ended_at or _utc_now()
        interventions = sum(int(row["n"]) for row in intervention_rows)
        accepted = sum(int(row["n"]) for row in intervention_rows if row["status"] == "accepted")
        return SessionStatsRecord(
            session_id=session_id,
            started_at=started_at,
            ended_at=ended_at,
            duration_seconds=max(0, int((end_bound - started_at).total_seconds())),
            observations=total,
            ok=ok,
            drift=drift,
            unjudged=total - judged,
            related_ratio=(ok / judged) if judged else None,
            interventions=interventions,
            interventions_accepted=accepted,
            top_drift_host=top_drift_row["url_host"] if top_drift_row else None,
            top_drift_count=int(top_drift_row["n"]) if top_drift_row else 0,
        )

    def session_report(self, session_id: str) -> SessionReportRecord:
        stats = self.session_stats(session_id)
        with self._connect() as conn:
            self._ensure_schema(conn)
            observation_rows = conn.execute(
                """
                SELECT observations.id, observations.ts,
                       CASE page_labels.label
                         WHEN 'related' THEN 'OK'
                         WHEN 'drift' THEN 'DRIFT'
                         ELSE observations.verdict
                       END AS verdict,
                       observations.url_host, observations.title,
                       observations.tier_reached, observations.tier1_reason
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                ORDER BY observations.ts ASC, observations.id ASC
                """,
                (session_id,),
            ).fetchall()
            intervention_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS n
                FROM interventions
                WHERE session_id = ?
                GROUP BY status
                """,
                (session_id,),
            ).fetchall()
            feedback_rows = conn.execute(
                """
                SELECT kind, COUNT(*) AS n
                FROM feedback
                WHERE session_id = ?
                GROUP BY kind
                """,
                (session_id,),
            ).fetchall()

        return self._report_from_rows(
            scope="session",
            session_id=session_id,
            report_date=None,
            started_at=stats.started_at,
            ended_at=stats.ended_at,
            observation_rows=observation_rows,
            intervention_rows=intervention_rows,
            feedback_rows=feedback_rows,
        )

    def daily_report(self, report_date: date) -> SessionReportRecord:
        local_start = datetime.combine(report_date, time.min).astimezone()
        local_end = local_start + timedelta(days=1)
        start_utc = local_start.astimezone(timezone.utc).isoformat()
        end_utc = local_end.astimezone(timezone.utc).isoformat()
        with self._connect() as conn:
            self._ensure_schema(conn)
            observation_rows = conn.execute(
                """
                SELECT observations.id, observations.ts,
                       CASE page_labels.label
                         WHEN 'related' THEN 'OK'
                         WHEN 'drift' THEN 'DRIFT'
                         ELSE observations.verdict
                       END AS verdict,
                       observations.url_host, observations.title,
                       observations.tier_reached, observations.tier1_reason
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.ts >= ? AND observations.ts < ?
                ORDER BY observations.ts ASC, observations.id ASC
                """,
                (start_utc, end_utc),
            ).fetchall()
            intervention_rows = conn.execute(
                """
                SELECT status, COUNT(*) AS n
                FROM interventions
                WHERE ts >= ? AND ts < ?
                GROUP BY status
                """,
                (start_utc, end_utc),
            ).fetchall()
            feedback_rows = conn.execute(
                """
                SELECT kind, COUNT(*) AS n
                FROM feedback
                WHERE ts >= ? AND ts < ?
                GROUP BY kind
                """,
                (start_utc, end_utc),
            ).fetchall()

        return self._report_from_rows(
            scope="daily",
            session_id=None,
            report_date=report_date.isoformat(),
            started_at=local_start,
            ended_at=local_end,
            observation_rows=observation_rows,
            intervention_rows=intervention_rows,
            feedback_rows=feedback_rows,
        )

    def latest_unhandled_intervention(self, session_id: str) -> InterventionRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT interventions.id, interventions.session_id, interventions.observation_id,
                       interventions.ts, interventions.message, interventions.status,
                       observations.tier1_reason
                FROM interventions
                LEFT JOIN observations ON observations.id = interventions.observation_id
                JOIN goals ON goals.session_id = interventions.session_id
                WHERE interventions.session_id = ?
                  AND observations.goal_revision = goals.goal_revision
                  AND interventions.status IN ('pending', 'delivered', 'delivery_failed')
                ORDER BY interventions.ts DESC, interventions.id DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return self._intervention_from_row(row) if row else None

    def latest_intervention_observation_host(self, session_id: str) -> str | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT observations.url_host
                FROM interventions
                LEFT JOIN observations ON observations.id = interventions.observation_id
                WHERE interventions.session_id = ?
                ORDER BY interventions.ts DESC, interventions.id DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return row["url_host"] if row else None

    def nag_count_today(self, session_id: str) -> int:
        midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        midnight_utc = midnight.astimezone(timezone.utc)
        with self._connect() as conn:
            self._ensure_schema(conn)
            count = conn.execute(
                """
                SELECT COUNT(*)
                FROM interventions
                WHERE session_id = ? AND ts >= ?
                """,
                (session_id, midnight_utc.isoformat()),
            ).fetchone()[0]
        return int(count)

    def last_intervention_ignored(self, session_id: str) -> bool:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT status
                FROM interventions
                WHERE session_id = ?
                ORDER BY ts DESC, id DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return bool(row and row["status"] in {"pending", "delivered", "delivery_failed"})

    def minutes_since_last_ok(
        self,
        session_id: str,
        as_of: datetime | None = None,
    ) -> int | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            row = conn.execute(
                """
                SELECT observations.ts
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                  AND observations.goal_revision IS ?
                  AND CASE page_labels.label
                        WHEN 'related' THEN 'OK'
                        WHEN 'drift' THEN 'DRIFT'
                        ELSE observations.verdict
                      END = 'OK'
                ORDER BY observations.ts DESC, observations.id DESC
                LIMIT 1
                """,
                (session_id, goal_revision),
            ).fetchone()
        if not row:
            return None
        seconds = max(0, int(((as_of or _utc_now()) - _parse_dt(row["ts"])).total_seconds()))
        return seconds // 60

    def note_attachment_observation(
        self,
        session_id: str,
        verdict: str | None,
        ts: datetime,
        drift_confirmed: bool,
    ) -> ReturnCandidateRecord | None:
        if verdict not in {"OK", "DRIFT"}:
            return None

        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT drift_started_at, drift_confirmed_at, last_celebration_ts,
                       last_celebration_template
                FROM attachment_states
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            drift_started_at = _parse_dt(row["drift_started_at"]) if row and row["drift_started_at"] else None
            drift_confirmed_at = _parse_dt(row["drift_confirmed_at"]) if row and row["drift_confirmed_at"] else None
            last_celebration_ts = _parse_dt(row["last_celebration_ts"]) if row and row["last_celebration_ts"] else None
            last_template = row["last_celebration_template"] if row else None

            candidate = None
            if verdict == "DRIFT":
                drift_started_at = drift_started_at or ts
                if drift_confirmed and drift_confirmed_at is None:
                    drift_confirmed_at = ts
            else:
                if drift_started_at and drift_confirmed_at:
                    candidate = ReturnCandidateRecord(
                        drift_started_at=drift_started_at,
                        drift_confirmed_at=drift_confirmed_at,
                        last_celebration_ts=last_celebration_ts,
                        last_celebration_template=last_template,
                    )
                drift_started_at = None
                drift_confirmed_at = None

            conn.execute(
                """
                INSERT INTO attachment_states (
                    session_id, drift_started_at, drift_confirmed_at,
                    last_celebration_ts, last_celebration_template, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    drift_started_at = excluded.drift_started_at,
                    drift_confirmed_at = excluded.drift_confirmed_at,
                    last_celebration_ts = excluded.last_celebration_ts,
                    last_celebration_template = excluded.last_celebration_template,
                    updated_at = excluded.updated_at
                """,
                (
                    session_id,
                    drift_started_at.isoformat() if drift_started_at else None,
                    drift_confirmed_at.isoformat() if drift_confirmed_at else None,
                    last_celebration_ts.isoformat() if last_celebration_ts else None,
                    last_template,
                    ts.isoformat(),
                ),
            )
        return candidate

    def record_celebration_delivered(
        self,
        session_id: str,
        observation_id: str,
        return_minutes: int,
        template: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute(
                """
                INSERT INTO attachment_states (
                    session_id, drift_started_at, drift_confirmed_at,
                    last_celebration_ts, last_celebration_template, updated_at
                )
                VALUES (?, NULL, NULL, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    last_celebration_ts = excluded.last_celebration_ts,
                    last_celebration_template = excluded.last_celebration_template,
                    updated_at = excluded.updated_at
                """,
                (session_id, now.isoformat(), template, now.isoformat()),
            )
            self._append_event(
                conn,
                session_id,
                "celebration.delivered",
                {
                    "observation_id": observation_id,
                    "return_minutes": return_minutes,
                },
                now,
            )

    def record_delivery_report(
        self,
        session_id: str,
        intervention_id: str,
        ok: bool,
        error: str | None,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "delivery.reported",
                {"intervention_id": intervention_id, "ok": ok, "error": error},
                now,
            )

    def record_delivery_suppressed_quiet_hours(
        self,
        session_id: str,
        intervention_id: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "delivery.suppressed_quiet_hours",
                {"intervention_id": intervention_id},
                now,
            )

    def record_voice_spoken(
        self,
        session_id: str,
        intervention_id: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "delivery.voice_spoken",
                {"intervention_id": intervention_id},
                now,
            )

    def get_settings(self) -> dict[str, Any]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute("SELECT key, value_json FROM settings").fetchall()
        settings: dict[str, Any] = {}
        for row in rows:
            try:
                settings[row["key"]] = json.loads(row["value_json"])
            except json.JSONDecodeError:
                continue
        return settings

    def update_settings(self, partial: dict[str, Any], ts: datetime | None = None) -> dict[str, Any]:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute("SELECT key, value_json FROM settings").fetchall()
            current: dict[str, Any] = {}
            for row in rows:
                try:
                    current[row["key"]] = json.loads(row["value_json"])
                except json.JSONDecodeError:
                    continue

            changed = {
                key: value
                for key, value in partial.items()
                if current.get(key) != value
            }
            for key, value in changed.items():
                conn.execute(
                    """
                    INSERT INTO settings (key, value_json, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json = excluded.value_json,
                        updated_at = excluded.updated_at
                    """,
                    (key, json.dumps(value), now.isoformat()),
                )
            if changed:
                self._append_event(
                    conn,
                    None,
                    "settings.updated",
                    {"keys": sorted(changed.keys())},
                    now,
                )

            rows = conn.execute("SELECT key, value_json FROM settings").fetchall()

        settings: dict[str, Any] = {}
        for row in rows:
            try:
                settings[row["key"]] = json.loads(row["value_json"])
            except json.JSONDecodeError:
                continue
        return settings

    def record_session_snoozed(
        self,
        session_id: str,
        snoozed_until: datetime,
        source: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "session.snoozed",
                {"snoozed_until": snoozed_until.isoformat(), "source": source},
                now,
            )

    def set_current_goal(
        self,
        raw_text: str,
        exemplar: list[float] | None = None,
        available_time_minutes: int | None = None,
        ensure_session: bool = False,
    ) -> GoalRecord:
        normalized_goal = raw_text.strip()
        if not normalized_goal:
            raise ValueError("goal text must not be empty")
        if available_time_minutes is not None and available_time_minutes < 1:
            raise ValueError("available_time_minutes must be positive")

        now = _utc_now()
        now_text = now.isoformat()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            session_row = conn.execute(
                "SELECT id FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
            if not session_row:
                if not ensure_session:
                    raise NoActiveSessionError("create a session before setting a goal")
                session_id = f"sess_{uuid.uuid4().hex}"
                conn.execute(
                    "INSERT INTO sessions (id, created_at, active) VALUES (?, ?, 1)",
                    (session_id, now_text),
                )
                conn.execute(
                    """
                    INSERT INTO controller_states (
                        session_id, streak, obs_count, last_intervention_ts, snoozed_until, updated_at
                    )
                    VALUES (?, 0, 0, NULL, NULL, ?)
                    """,
                    (session_id, now_text),
                )
                self._append_event(conn, session_id, "session.created", {"active": True}, now)
            else:
                session_id = session_row["id"]
            previous_goal = conn.execute(
                """
                SELECT raw_text, available_time_minutes, goal_revision
                FROM goals
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            goal_changed = (
                previous_goal is None
                or previous_goal["raw_text"] != normalized_goal
                or previous_goal["available_time_minutes"] != available_time_minutes
            )
            previous_revision = int(previous_goal["goal_revision"]) if previous_goal else 0
            goal_revision = previous_revision + 1 if goal_changed else previous_revision
            conn.execute(
                """
                INSERT INTO goals (
                    session_id, raw_text, provenance, updated_at,
                    available_time_minutes, goal_revision
                )
                VALUES (?, ?, 'declared', ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    raw_text = excluded.raw_text,
                    provenance = excluded.provenance,
                    updated_at = excluded.updated_at,
                    available_time_minutes = excluded.available_time_minutes,
                    goal_revision = excluded.goal_revision
                """,
                (
                    session_id,
                    normalized_goal,
                    now_text,
                    available_time_minutes,
                    goal_revision,
                ),
            )
            conn.execute("DELETE FROM goal_exemplars WHERE session_id = ?", (session_id,))
            if exemplar is not None:
                conn.execute(
                    """
                    INSERT INTO goal_exemplars (id, session_id, position, vector_json, created_at)
                    VALUES (?, ?, 0, ?, ?)
                    """,
                    (f"gex_{uuid.uuid4().hex}", session_id, json.dumps(exemplar), now_text),
                )
            conn.execute("DELETE FROM goal_derived_exemplars WHERE session_id = ?", (session_id,))
            if goal_changed:
                self._reset_goal_scoped_state(conn, session_id, goal_revision, now)
            self._append_event(
                conn,
                session_id,
                "goal.declared",
                {
                    "raw_text": normalized_goal,
                    "provenance": "declared",
                    "available_time_minutes": available_time_minutes,
                    "goal_revision": goal_revision,
                },
                now,
            )

        return GoalRecord(
            session_id=session_id,
            raw_text=normalized_goal,
            exemplars=[exemplar] if exemplar is not None else self.get_goal_exemplars(session_id),
            provenance="declared",
            updated_at=now,
            goal_revision=goal_revision,
            available_time_minutes=available_time_minutes,
            derived_exemplars=[],
        )

    def goal_revision_is_current(self, session_id: str, goal_revision: int) -> bool:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT goal_revision FROM goals WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return bool(row and int(row["goal_revision"]) == goal_revision)

    def get_goal_exemplars(self, session_id: str) -> list[list[float]]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT vector_json
                FROM goal_exemplars
                WHERE session_id = ?
                ORDER BY position ASC
                """,
                (session_id,),
            ).fetchall()
        return [json.loads(row["vector_json"]) for row in rows]

    def get_goal_derived_exemplars(
        self,
        session_id: str,
        goal_revision: int,
    ) -> list[GoalDerivedExemplarRecord]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT phrase, vector_json, position
                FROM goal_derived_exemplars
                WHERE session_id = ? AND goal_revision = ?
                ORDER BY position ASC
                """,
                (session_id, goal_revision),
            ).fetchall()
        return [
            GoalDerivedExemplarRecord(
                phrase=row["phrase"],
                vector=json.loads(row["vector_json"]),
                position=int(row["position"]),
            )
            for row in rows
        ]

    def replace_goal_derived_exemplars(
        self,
        session_id: str,
        exemplars: list[Any],
        goal_revision: int,
        provider: str,
        latency_ms: int,
        ts: datetime | None = None,
    ) -> bool:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT goal_revision FROM goals WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if not current or int(current["goal_revision"]) != goal_revision:
                return False
            conn.execute("DELETE FROM goal_derived_exemplars WHERE session_id = ?", (session_id,))
            for position, exemplar in enumerate(exemplars):
                conn.execute(
                    """
                    INSERT INTO goal_derived_exemplars (
                        id, session_id, goal_revision, position, phrase, vector_json, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"gdex_{uuid.uuid4().hex}",
                        session_id,
                        goal_revision,
                        position,
                        exemplar.phrase,
                        json.dumps(exemplar.vector),
                        now.isoformat(),
                    ),
                )
            self._append_event(
                conn,
                session_id,
                "goal.enriched",
                {
                    "phrases": [exemplar.phrase for exemplar in exemplars],
                    "provider": provider,
                    "latency_ms": latency_ms,
                    "goal_revision": goal_revision,
                },
                now,
            )
        return True

    def record_goal_enrichment_failed(
        self,
        session_id: str,
        error_type: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "goal.enrichment_failed",
                {"error_type": error_type},
                now,
            )

    def claim_observation_request(
        self,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> tuple[ObservationRequestRecord, bool]:
        """Claim a browser-nav request without allowing a duplicate worker."""

        with self._connect() as conn:
            self._ensure_schema(conn)
            inserted = conn.execute(
                """
                INSERT INTO observation_requests (
                    idempotency_key, request_fingerprint, result_json
                )
                VALUES (?, ?, NULL)
                ON CONFLICT(idempotency_key) DO NOTHING
                """,
                (idempotency_key, request_fingerprint),
            )
            row = conn.execute(
                "SELECT * FROM observation_requests WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is None:
                raise RuntimeError("observation request disappeared after claim")
            record = self._observation_request_from_row(row)
            if record.request_fingerprint != request_fingerprint:
                raise IdempotencyConflictError(
                    "idempotency key was already used for a different browser-nav request"
                )
        return record, inserted.rowcount == 1

    def complete_observation_request(
        self,
        idempotency_key: str,
        request_fingerprint: str,
        result: dict[str, Any],
    ) -> ObservationRequestRecord:
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        with self._connect() as conn:
            self._ensure_schema(conn)
            updated = conn.execute(
                """
                UPDATE observation_requests
                SET result_json = ?
                WHERE idempotency_key = ?
                  AND request_fingerprint = ?
                  AND result_json IS NULL
                """,
                (result_json, idempotency_key, request_fingerprint),
            )
            row = conn.execute(
                "SELECT * FROM observation_requests WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is None:
                raise RuntimeError("observation request disappeared before completion")
            record = self._observation_request_from_row(row)
            if record.request_fingerprint != request_fingerprint:
                raise IdempotencyConflictError(
                    "idempotency key was already used for a different browser-nav request"
                )
            if updated.rowcount != 1 and record.result != result:
                raise RuntimeError("observation request already has a different result")
        return record

    def release_observation_request(
        self,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> bool:
        """Release an unfinished claim after request processing fails."""

        with self._connect() as conn:
            self._ensure_schema(conn)
            deleted = conn.execute(
                """
                DELETE FROM observation_requests
                WHERE idempotency_key = ?
                  AND request_fingerprint = ?
                  AND result_json IS NULL
                """,
                (idempotency_key, request_fingerprint),
            )
        return deleted.rowcount == 1

    def set_observation_processing_stage(
        self,
        observation: Observation,
        goal_revision: int,
        stage: str,
        ts: datetime | None = None,
    ) -> ObservationProcessingStateRecord:
        if stage not in {"tier0", "tier1"}:
            raise ValueError(f"unsupported observation processing stage: {stage}")
        now = ts or _utc_now()
        payload = observation.payload
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute(
                """
                INSERT INTO observation_processing_states (
                    observation_id, session_id, goal_revision, tab_id,
                    url_host, url_path_hash, title, stage, started_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(observation_id) DO UPDATE SET
                    stage = excluded.stage,
                    updated_at = excluded.updated_at
                """,
                (
                    observation.id,
                    observation.session_id,
                    goal_revision,
                    payload.get("tab_id"),
                    payload.get("url_host"),
                    payload.get("url_path_hash"),
                    payload.get("title"),
                    stage,
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
            row = conn.execute(
                "SELECT * FROM observation_processing_states WHERE observation_id = ?",
                (observation.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("observation processing state disappeared after upsert")
        return self._observation_processing_state_from_row(row)

    def clear_observation_processing_state(self, observation_id: str) -> bool:
        with self._connect() as conn:
            self._ensure_schema(conn)
            deleted = conn.execute(
                "DELETE FROM observation_processing_states WHERE observation_id = ?",
                (observation_id,),
            )
        return deleted.rowcount == 1

    def observation_processing_state_for_page(
        self,
        session_id: str,
        goal_revision: int,
        tab_id: int,
        url_host: str,
        url_path_hash: str,
        *,
        stale_after_seconds: int = 600,
    ) -> ObservationProcessingStateRecord | None:
        cutoff = _utc_now() - timedelta(seconds=max(1, stale_after_seconds))
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute(
                "DELETE FROM observation_processing_states WHERE updated_at < ?",
                (cutoff.isoformat(),),
            )
            row = conn.execute(
                """
                SELECT *
                FROM observation_processing_states
                WHERE session_id = ?
                  AND goal_revision = ?
                  AND tab_id = ?
                  AND url_host = ?
                  AND url_path_hash = ?
                ORDER BY updated_at DESC, observation_id DESC
                LIMIT 1
                """,
                (session_id, goal_revision, tab_id, url_host, url_path_hash),
            ).fetchone()
        return self._observation_processing_state_from_row(row) if row else None

    def record_observation(
        self,
        observation: Observation,
        goal_revision: int | None = None,
    ) -> ObservationRecord:
        payload = observation.payload
        features = observation.features.model_dump()
        with self._connect() as conn:
            self._ensure_schema(conn)
            if goal_revision is None:
                goal_revision = self._current_goal_revision_in_conn(conn, observation.session_id)
            conn.execute(
                """
                INSERT INTO observations (
                    id, session_id, ts, source, url_host, url_path_hash, title, tab_id,
                    features_json, verdict, tier_reached, tier1_reason, goal_revision
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    observation.id,
                    observation.session_id,
                    observation.ts.isoformat(),
                    observation.source.value,
                    payload.get("url_host"),
                    payload.get("url_path_hash"),
                    payload.get("title"),
                    payload.get("tab_id"),
                    json.dumps(features),
                    observation.verdict.value if observation.verdict else None,
                    observation.features.tier_reached,
                    observation.tier1_reason,
                    goal_revision,
                ),
            )
            self._append_event(
                conn,
                observation.session_id,
                "observation.recorded",
                {
                    "observation_id": observation.id,
                    "source": observation.source.value,
                    "url_host": payload.get("url_host"),
                    "title": payload.get("title"),
                    "goal_revision": goal_revision,
                },
                observation.ts,
            )
        return ObservationRecord(
            id=observation.id,
            session_id=observation.session_id,
            ts=observation.ts,
            source=observation.source.value,
            url_host=payload.get("url_host"),
            url_path_hash=payload.get("url_path_hash"),
            title=payload.get("title"),
            tab_id=payload.get("tab_id"),
            features=features,
            verdict=observation.verdict.value if observation.verdict else None,
            tier_reached=observation.features.tier_reached,
            tier1_reason=observation.tier1_reason,
            goal_revision=goal_revision,
        )

    def store_observation_excerpt(
        self,
        session_id: str,
        observation_id: str,
        text: str,
        char_limit: int,
        retention_limit: int,
        ts: datetime | None = None,
    ) -> ObservationExcerptRecord:
        now = ts or _utc_now()
        cleaned = " ".join(text.split())[:char_limit]
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT session_id FROM observations WHERE id = ? AND session_id = ?",
                (observation_id, session_id),
            ).fetchone()
            if not row:
                raise ValueError("observation not found")
            conn.execute(
                """
                INSERT INTO observation_excerpts (
                    observation_id, session_id, captured_at, text, char_count
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(observation_id) DO UPDATE SET
                    captured_at = excluded.captured_at,
                    text = excluded.text,
                    char_count = excluded.char_count
                """,
                (observation_id, session_id, now.isoformat(), cleaned, len(cleaned)),
            )
            conn.execute(
                """
                DELETE FROM observation_excerpts
                WHERE session_id = ?
                  AND observation_id NOT IN (
                      SELECT observation_id
                      FROM observation_excerpts
                      WHERE session_id = ?
                      ORDER BY captured_at DESC, observation_id DESC
                      LIMIT ?
                  )
                """,
                (session_id, session_id, max(1, retention_limit)),
            )
            self._append_event(
                conn,
                session_id,
                "d7.content_captured",
                {"observation_id": observation_id, "char_count": len(cleaned)},
                now,
            )
        return ObservationExcerptRecord(
            observation_id=observation_id,
            session_id=session_id,
            captured_at=now,
            text=cleaned,
            char_count=len(cleaned),
        )

    def get_observation_excerpt(self, observation_id: str) -> ObservationExcerptRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT observation_id, session_id, captured_at, text, char_count
                FROM observation_excerpts
                WHERE observation_id = ?
                """,
                (observation_id,),
            ).fetchone()
        return self._excerpt_from_row(row) if row else None

    def recent_observation_content(
        self,
        session_id: str,
        limit: int,
        excerpt_char_limit: int,
        goal_revision: int | None = None,
    ) -> list[ObservationContentSummary]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            if goal_revision is None:
                goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            rows = conn.execute(
                """
                SELECT observations.id, observations.title, observations.verdict, observation_excerpts.text
                FROM observation_excerpts
                JOIN observations ON observations.id = observation_excerpts.observation_id
                WHERE observation_excerpts.session_id = ?
                  AND observations.goal_revision IS ?
                ORDER BY observation_excerpts.captured_at DESC, observations.id DESC
                LIMIT ?
                """,
                (session_id, goal_revision, limit),
            ).fetchall()
        return [
            ObservationContentSummary(
                observation_id=row["id"],
                title=row["title"],
                verdict=row["verdict"],
                text=row["text"][:excerpt_char_limit],
            )
            for row in reversed(rows)
        ]

    def get_drift_clock_state(self, session_id: str) -> DriftClockStateRecord:
        now = _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = self._ensure_drift_clock_state_row(conn, session_id, now)
        return self._drift_clock_state_from_row(row)

    def reset_drift_clock_state(self, session_id: str, ts: datetime | None = None) -> DriftClockStateRecord:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._reset_drift_clock_state_in_conn(conn, session_id, now)
            row = self._ensure_drift_clock_state_row(conn, session_id, now)
        return self._drift_clock_state_from_row(row)

    def _reset_goal_scoped_state(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        goal_revision: int,
        now: datetime,
    ) -> None:
        self._write_controller_state(
            conn,
            ControllerStateRecord(
                session_id=session_id,
                streak=0,
                obs_count=0,
                last_intervention_ts=None,
                snoozed_until=None,
                alignment_score=None,
                drift_latched=False,
                updated_at=now,
            ),
        )
        conn.execute("DELETE FROM attachment_states WHERE session_id = ?", (session_id,))
        conn.execute(
            "DELETE FROM observation_processing_states WHERE session_id = ? AND goal_revision != ?",
            (session_id, goal_revision),
        )
        cancelled = conn.execute(
            """
            UPDATE intervention_candidates
            SET status = 'cancelled', updated_at = ?
            WHERE session_id = ? AND goal_revision != ?
              AND status IN ('pending', 'in_flight')
            RETURNING id, observation_id
            """,
            (now.isoformat(), session_id, goal_revision),
        ).fetchall()
        for row in cancelled:
            self._append_event(
                conn,
                session_id,
                "intervention.candidate_cancelled",
                {
                    "candidate_id": row["id"],
                    "observation_id": row["observation_id"],
                    "intervention_id": None,
                    "reason": "goal_revised",
                },
                now,
            )
        self._reset_drift_clock_state_in_conn(conn, session_id, now)

    def _reset_drift_clock_state_in_conn(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        now: datetime,
    ) -> None:
        conn.execute(
            """
            INSERT INTO drift_clock_states (
                session_id, current_page_drift_seconds, continuous_drift_seconds,
                cumulative_drift_seconds, next_review_mode_seconds, review_status, updated_at
            )
            VALUES (?, 0, 0, 0, 0, 'none', ?)
            ON CONFLICT(session_id) DO UPDATE SET
                active_observation_id = NULL,
                active_tab_id = NULL,
                active_url_host = NULL,
                active_url_path_hash = NULL,
                active_verdict = NULL,
                active_since_at = NULL,
                last_heartbeat_at = NULL,
                current_page_drift_seconds = 0,
                continuous_drift_seconds = 0,
                cumulative_drift_seconds = 0,
                next_review_mode_seconds = 0,
                review_observation_id = NULL,
                review_started_at = NULL,
                review_status = 'none',
                last_defer_reason = NULL,
                updated_at = excluded.updated_at
            """,
            (session_id, now.isoformat()),
        )
        self._append_event(conn, session_id, "d7.clock_reset", {}, now)
        conn.execute("DELETE FROM drift_page_dwell_states WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))

    def record_drift_presence(
        self,
        session_id: str,
        observation_id: str,
        event_id: str,
        kind: str,
        tab_id: int,
        url_path_hash: str,
        max_gap_seconds: int,
        review_timeout_seconds: int | None = None,
        reset_review_boundary_on_ok: bool = True,
        ts: datetime | None = None,
    ) -> tuple[DriftClockStateRecord, bool, bool]:
        if kind not in {"active", "heartbeat", "inactive"}:
            raise ValueError("unknown presence kind")
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            state_row = self._ensure_drift_clock_state_row(conn, session_id, now)
            state = self._drift_clock_state_from_row(state_row)
            review_started_at = state.review_started_at or state.updated_at
            if (
                review_timeout_seconds
                and state.review_observation_id
                and (now - review_started_at).total_seconds() > review_timeout_seconds
            ):
                conn.execute(
                    """
                    UPDATE drift_clock_states
                    SET review_observation_id = NULL, review_started_at = NULL,
                        review_status = 'retry', last_defer_reason = 'review_timeout', updated_at = ?
                    WHERE session_id = ? AND review_observation_id IS NOT NULL
                    """,
                    (now.isoformat(), session_id),
                )
                conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))
                self._append_event(
                    conn,
                    session_id,
                    "d7.review_expired",
                    {"observation_id": state.review_observation_id},
                    now,
                )
                state = self._drift_clock_state_from_row(
                    self._ensure_drift_clock_state_row(conn, session_id, now)
                )
            duplicate = conn.execute(
                "SELECT 1 FROM dwell_presence_events WHERE event_id = ?",
                (event_id,),
            ).fetchone()
            if duplicate:
                return state, False, True

            active_matches = (
                state.active_observation_id == observation_id
                and state.active_tab_id == tab_id
                and state.active_url_path_hash == url_path_hash
            )
            conn.execute(
                """
                INSERT INTO dwell_presence_events (event_id, session_id, observation_id, received_at)
                VALUES (?, ?, ?, ?)
                """,
                (event_id, session_id, observation_id, now.isoformat()),
            )
            if not active_matches and kind == "active":
                observation_row = conn.execute(
                    """
                    SELECT verdict, url_host
                    FROM observations
                    WHERE id = ? AND session_id = ? AND tab_id = ? AND url_path_hash = ?
                    """,
                    (observation_id, session_id, tab_id, url_path_hash),
                ).fetchone()
                if observation_row:
                    verdict = observation_row["verdict"]
                    url_host = observation_row["url_host"]
                    same_drift_page = (
                        verdict == "DRIFT"
                        and state.active_url_host == url_host
                        and state.active_url_path_hash == url_path_hash
                    )
                    page_dwell_row = conn.execute(
                        """
                        SELECT drift_seconds
                        FROM drift_page_dwell_states
                        WHERE session_id = ? AND url_host = ? AND url_path_hash = ?
                        """,
                        (session_id, url_host, url_path_hash),
                    ).fetchone()
                    current_page = (
                        int(page_dwell_row["drift_seconds"])
                        if verdict == "DRIFT" and page_dwell_row
                        else 0
                    )
                    continuous = state.continuous_drift_seconds if verdict == "DRIFT" else 0
                    reset_review_boundary = verdict == "OK" and reset_review_boundary_on_ok
                    next_review = 0 if reset_review_boundary else state.next_review_mode_seconds
                    last_defer_reason = None if reset_review_boundary else state.last_defer_reason
                    if reset_review_boundary:
                        conn.execute("DELETE FROM drift_page_dwell_states WHERE session_id = ?", (session_id,))
                    review_observation_id = state.review_observation_id
                    review_started_at = state.review_started_at
                    review_status = state.review_status
                    if review_observation_id and review_observation_id != observation_id:
                        conn.execute(
                            "DELETE FROM d7_prepared_reviews WHERE session_id = ?",
                            (session_id,),
                        )
                        review_observation_id = None
                        review_started_at = None
                        review_status = "none"
                    active_since_at = (
                        state.active_since_at.isoformat()
                        if same_drift_page and state.active_since_at
                        else now.isoformat()
                    )
                    conn.execute(
                        """
                        UPDATE drift_clock_states
                        SET active_observation_id = ?, active_tab_id = ?, active_url_host = ?,
                            active_url_path_hash = ?,
                            active_verdict = ?, active_since_at = ?, last_heartbeat_at = ?,
                            current_page_drift_seconds = ?, continuous_drift_seconds = ?,
                            next_review_mode_seconds = ?, review_observation_id = ?,
                            review_started_at = ?, review_status = ?, last_defer_reason = ?, updated_at = ?
                        WHERE session_id = ?
                        """,
                        (
                            observation_id,
                            tab_id,
                            url_host,
                            url_path_hash,
                            verdict,
                            active_since_at,
                            now.isoformat(),
                            current_page,
                            continuous,
                            next_review,
                            review_observation_id,
                            review_started_at.isoformat() if review_started_at else None,
                            review_status,
                            last_defer_reason,
                            now.isoformat(),
                            session_id,
                        ),
                    )
                    self._append_event(
                        conn,
                        session_id,
                        "d7.clock_reactivated",
                        {"observation_id": observation_id, "verdict": verdict},
                        now,
                    )
                    row = self._ensure_drift_clock_state_row(conn, session_id, now)
                    return self._drift_clock_state_from_row(row), True, False
            if not active_matches:
                self._append_event(
                    conn,
                    session_id,
                    "d7.presence_ignored",
                    {"observation_id": observation_id, "kind": kind},
                    now,
                )
                return state, False, False

            elapsed = 0
            if kind != "active" and state.last_heartbeat_at:
                elapsed = max(0, int((now - state.last_heartbeat_at).total_seconds()))
                elapsed = min(elapsed, max_gap_seconds)
            current_page = state.current_page_drift_seconds
            continuous = state.continuous_drift_seconds
            cumulative = state.cumulative_drift_seconds
            if state.active_verdict == "DRIFT":
                current_page += elapsed
                continuous += elapsed
                cumulative += elapsed
                if state.active_url_host and state.active_url_path_hash:
                    conn.execute(
                        """
                        INSERT INTO drift_page_dwell_states (
                            session_id, url_host, url_path_hash, drift_seconds, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(session_id, url_host, url_path_hash) DO UPDATE SET
                            drift_seconds = excluded.drift_seconds,
                            updated_at = excluded.updated_at
                        """,
                        (
                            session_id,
                            state.active_url_host,
                            state.active_url_path_hash,
                            current_page,
                            now.isoformat(),
                        ),
                    )

            active_observation_id: str | None = observation_id
            active_tab_id: int | None = tab_id
            active_path_hash: str | None = url_path_hash
            active_verdict: str | None = state.active_verdict
            active_since_at = state.active_since_at.isoformat() if state.active_since_at else now.isoformat()
            if kind == "inactive":
                active_observation_id = None
                active_tab_id = None
                active_verdict = None
                active_since_at = None

            conn.execute(
                """
                UPDATE drift_clock_states
                SET active_observation_id = ?, active_tab_id = ?, active_url_path_hash = ?,
                    active_verdict = ?, active_since_at = ?, last_heartbeat_at = ?,
                    current_page_drift_seconds = ?, continuous_drift_seconds = ?,
                    cumulative_drift_seconds = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (
                    active_observation_id,
                    active_tab_id,
                    active_path_hash,
                    active_verdict,
                    active_since_at,
                    now.isoformat(),
                    current_page,
                    continuous,
                    cumulative,
                    now.isoformat(),
                    session_id,
                ),
            )
            if kind != "heartbeat":
                self._append_event(
                    conn,
                    session_id,
                    "d7.presence_recorded",
                    {"observation_id": observation_id, "kind": kind, "elapsed_seconds": elapsed},
                    now,
                )
            row = self._ensure_drift_clock_state_row(conn, session_id, now)
        return self._drift_clock_state_from_row(row), True, False

    def begin_d7_review(
        self,
        session_id: str,
        observation_id: str,
        ts: datetime | None = None,
    ) -> bool:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = self._ensure_drift_clock_state_row(conn, session_id, now)
            if row["active_observation_id"] != observation_id or row["review_observation_id"] is not None:
                return False
            updated = conn.execute(
                """
                UPDATE drift_clock_states
                SET review_observation_id = ?, review_started_at = ?,
                    review_status = 'reviewing', updated_at = ?
                WHERE session_id = ? AND review_observation_id IS NULL
                """,
                (observation_id, now.isoformat(), now.isoformat(), session_id),
            )
            if updated.rowcount != 1:
                return False
            self._append_event(conn, session_id, "d7.review_started", {"observation_id": observation_id}, now)
        return True

    def d7_review_is_current(self, session_id: str, observation_id: str) -> bool:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT 1
                FROM drift_clock_states
                WHERE session_id = ?
                  AND active_observation_id = ?
                  AND review_observation_id = ?
                  AND review_status = 'reviewing'
                """,
                (session_id, observation_id, observation_id),
            ).fetchone()
        return row is not None

    def prepare_d7_review(
        self,
        session_id: str,
        observation_id: str,
        goal_revision: int,
        deliver_after: datetime,
        outcome: dict[str, Any],
        ts: datetime | None = None,
    ) -> bool:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            prepared = conn.execute(
                """
                INSERT INTO d7_prepared_reviews (
                    session_id, observation_id, goal_revision, deliver_after,
                    outcome_json, prepared_at
                )
                SELECT ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                    SELECT 1
                    FROM drift_clock_states
                    WHERE session_id = ?
                      AND active_observation_id = ?
                      AND review_observation_id = ?
                      AND review_status = 'reviewing'
                )
                ON CONFLICT(session_id) DO UPDATE SET
                    observation_id = excluded.observation_id,
                    goal_revision = excluded.goal_revision,
                    deliver_after = excluded.deliver_after,
                    outcome_json = excluded.outcome_json,
                    prepared_at = excluded.prepared_at
                """,
                (
                    session_id,
                    observation_id,
                    goal_revision,
                    deliver_after.isoformat(),
                    json.dumps(outcome, ensure_ascii=False),
                    now.isoformat(),
                    session_id,
                    observation_id,
                    observation_id,
                ),
            )
            if prepared.rowcount != 1:
                return False
            self._append_event(
                conn,
                session_id,
                "d7.review_prepared",
                {
                    "observation_id": observation_id,
                    "goal_revision": goal_revision,
                    "deliver_after": deliver_after.isoformat(),
                },
                now,
            )
        return True

    def queue_d7_review(
        self,
        session_id: str,
        observation_id: str,
        goal_revision: int,
        deliver_after: datetime,
        ts: datetime | None = None,
    ) -> bool:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            queued = conn.execute(
                """
                INSERT INTO d7_prepared_reviews (
                    session_id, observation_id, goal_revision, deliver_after,
                    outcome_json, prepared_at
                )
                SELECT ?, ?, ?, ?, NULL, NULL
                WHERE EXISTS (
                    SELECT 1
                    FROM drift_clock_states
                    WHERE session_id = ?
                      AND active_observation_id = ?
                      AND review_observation_id = ?
                      AND review_status = 'reviewing'
                )
                ON CONFLICT(session_id) DO UPDATE SET
                    observation_id = excluded.observation_id,
                    goal_revision = excluded.goal_revision,
                    deliver_after = excluded.deliver_after,
                    outcome_json = NULL,
                    prepared_at = NULL
                """,
                (
                    session_id,
                    observation_id,
                    goal_revision,
                    deliver_after.isoformat(),
                    session_id,
                    observation_id,
                    observation_id,
                ),
            )
            if queued.rowcount != 1:
                return False
            self._append_event(
                conn,
                session_id,
                "d7.review_queued",
                {
                    "observation_id": observation_id,
                    "goal_revision": goal_revision,
                    "deliver_after": deliver_after.isoformat(),
                },
                now,
            )
        return True

    def get_prepared_d7_review(
        self,
        session_id: str,
        observation_id: str,
    ) -> PreparedD7ReviewRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT session_id, observation_id, goal_revision, deliver_after,
                       outcome_json, prepared_at
                FROM d7_prepared_reviews
                WHERE session_id = ? AND observation_id = ?
                """,
                (session_id, observation_id),
            ).fetchone()
        if not row:
            return None
        return PreparedD7ReviewRecord(
            session_id=row["session_id"],
            observation_id=row["observation_id"],
            goal_revision=int(row["goal_revision"]),
            deliver_after=_parse_dt(row["deliver_after"]),
            outcome=json.loads(row["outcome_json"]) if row["outcome_json"] else None,
            prepared_at=_parse_dt(row["prepared_at"]) if row["prepared_at"] else None,
        )

    def defer_d7_review(
        self,
        session_id: str,
        observation_id: str,
        next_review_mode_seconds: int,
        reason: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            updated = conn.execute(
                """
                UPDATE drift_clock_states
                SET next_review_mode_seconds = ?, review_observation_id = NULL, review_started_at = NULL,
                    review_status = 'deferred', last_defer_reason = ?, updated_at = ?
                WHERE session_id = ? AND review_observation_id = ?
                """,
                (next_review_mode_seconds, reason, now.isoformat(), session_id, observation_id),
            )
            if updated.rowcount != 1:
                return
            conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))
            self._append_event(
                conn,
                session_id,
                "d7.review_deferred",
                {
                    "observation_id": observation_id,
                    "next_review_mode_seconds": next_review_mode_seconds,
                    "reason": reason,
                },
                now,
            )

    def complete_d7_review_notification(
        self,
        session_id: str,
        observation_id: str,
        next_review_mode_seconds: int,
        ts: datetime | None = None,
    ) -> None:
        # A delivered nag must consume the review window like an acceptable
        # defer does; otherwise every later presence event on the still-dwelled
        # page re-qualifies immediately and the user is nagged per heartbeat.
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            updated = conn.execute(
                """
                UPDATE drift_clock_states
                SET review_observation_id = NULL, review_started_at = NULL, review_status = 'notified',
                    next_review_mode_seconds = ?, last_defer_reason = NULL, updated_at = ?
                WHERE session_id = ? AND review_observation_id = ?
                """,
                (next_review_mode_seconds, now.isoformat(), session_id, observation_id),
            )
            if updated.rowcount != 1:
                return
            conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))
            self._append_event(
                conn,
                session_id,
                "d7.review_notified",
                {"observation_id": observation_id, "next_review_mode_seconds": next_review_mode_seconds},
                now,
            )

    def commit_d7_review_notification(
        self,
        session_id: str,
        observation_id: str,
        message: str,
        controller_state: ControllerStateRecord,
        next_review_mode_seconds: int,
        ts: datetime | None = None,
    ) -> str | None:
        """Atomically claim a prepared review and persist its notification."""
        if controller_state.session_id != session_id:
            raise ValueError("controller state belongs to another session")
        now = ts or _utc_now()
        intervention_id = f"int_{uuid.uuid4().hex}"
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            claimed = conn.execute(
                """
                UPDATE drift_clock_states
                SET review_status = 'committing', updated_at = ?
                WHERE session_id = ?
                  AND active_observation_id = ?
                  AND review_observation_id = ?
                  AND review_status = 'reviewing'
                  AND EXISTS (
                      SELECT 1
                      FROM d7_prepared_reviews
                      WHERE session_id = ?
                        AND observation_id = ?
                        AND outcome_json IS NOT NULL
                        AND deliver_after <= ?
                  )
                """,
                (
                    now.isoformat(),
                    session_id,
                    observation_id,
                    observation_id,
                    session_id,
                    observation_id,
                    now.isoformat(),
                ),
            )
            if claimed.rowcount != 1:
                return None

            self._append_event(
                conn,
                session_id,
                "tier2.confirmed",
                {
                    "observation_id": observation_id,
                    "confirm_drift": True,
                    "message": message,
                },
                now,
            )
            self._write_controller_state(conn, controller_state)
            self._insert_intervention(
                conn,
                intervention_id,
                session_id,
                observation_id,
                message,
                now,
            )
            completed = conn.execute(
                """
                UPDATE drift_clock_states
                SET review_observation_id = NULL, review_started_at = NULL,
                    review_status = 'notified', next_review_mode_seconds = ?,
                    last_defer_reason = NULL, updated_at = ?
                WHERE session_id = ?
                  AND review_observation_id = ?
                  AND review_status = 'committing'
                """,
                (
                    next_review_mode_seconds,
                    now.isoformat(),
                    session_id,
                    observation_id,
                ),
            )
            if completed.rowcount != 1:
                raise RuntimeError("failed to complete claimed D7 review")
            conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))
            self._append_event(
                conn,
                session_id,
                "d7.review_notified",
                {
                    "observation_id": observation_id,
                    "next_review_mode_seconds": next_review_mode_seconds,
                },
                now,
            )
        return intervention_id

    def release_d7_review(
        self,
        session_id: str,
        observation_id: str,
        reason: str,
        ts: datetime | None = None,
    ) -> bool:
        """Clear an unfinished review without consuming a time boundary."""
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            updated = conn.execute(
                """
                UPDATE drift_clock_states
                SET review_observation_id = NULL, review_started_at = NULL,
                    review_status = 'retry', last_defer_reason = ?, updated_at = ?
                WHERE session_id = ? AND review_observation_id = ?
                """,
                (reason, now.isoformat(), session_id, observation_id),
            )
            if updated.rowcount != 1:
                return False
            conn.execute("DELETE FROM d7_prepared_reviews WHERE session_id = ?", (session_id,))
            self._append_event(
                conn,
                session_id,
                "d7.review_released",
                {"observation_id": observation_id, "reason": reason},
                now,
            )
        return True

    def record_d7_content_unavailable(
        self,
        session_id: str,
        observation_id: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "d7.content_unavailable",
                {"observation_id": observation_id},
                now,
            )

    def record_dropped_observation(
        self,
        session_id: str | None,
        source: str,
        url_host: str,
        reason: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "observation.dropped",
                {
                    "source": source,
                    "url_host": url_host,
                    "reason": reason,
                },
                now,
            )

    def record_tier1_result(
        self,
        session_id: str,
        observation_id: str,
        verdict: str,
        reason: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute(
                "UPDATE observations SET tier1_reason = ? WHERE id = ? AND session_id = ?",
                (reason, observation_id, session_id),
            )
            self._append_event(
                conn,
                session_id,
                "tier1.classified",
                {
                    "observation_id": observation_id,
                    "verdict": verdict,
                    "reason": reason,
                },
                now,
            )

    def record_tier1_provider_error(
        self,
        session_id: str,
        observation_id: str,
        error_type: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "tier1.provider_error",
                {
                    "observation_id": observation_id,
                    "error_type": error_type,
                },
                now,
            )

    def record_provider_degraded(self, tier: int, reason: str, ts: datetime | None = None) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                None,
                "provider.degraded",
                {"tier": tier, "reason": reason},
                now,
            )

    def get_controller_state(self, session_id: str) -> ControllerStateRecord:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT session_id, streak, obs_count, last_intervention_ts, snoozed_until,
                       alignment_score, drift_latched, updated_at
                FROM controller_states
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if not row:
                now = _utc_now()
                conn.execute(
                    """
                    INSERT INTO controller_states (
                        session_id, streak, obs_count, last_intervention_ts, snoozed_until, updated_at
                    )
                    VALUES (?, 0, 0, NULL, NULL, ?)
                    """,
                    (session_id, now.isoformat()),
                )
                row = conn.execute(
                    """
                    SELECT session_id, streak, obs_count, last_intervention_ts, snoozed_until,
                           alignment_score, drift_latched, updated_at
                    FROM controller_states
                    WHERE session_id = ?
                    """,
                    (session_id,),
                ).fetchone()
        return self._controller_state_from_row(row)

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
        now = ts or _utc_now()
        state = ControllerStateRecord(
            session_id=session_id,
            streak=streak,
            obs_count=obs_count,
            last_intervention_ts=last_intervention_ts,
            snoozed_until=snoozed_until,
            alignment_score=alignment_score,
            drift_latched=drift_latched,
            updated_at=now,
        )
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._write_controller_state(conn, state)
        return state

    def _write_controller_state(
        self,
        conn: sqlite3.Connection,
        state: ControllerStateRecord,
    ) -> None:
        conn.execute(
            """
            INSERT INTO controller_states (
                session_id, streak, obs_count, last_intervention_ts, snoozed_until,
                alignment_score, drift_latched, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                streak = excluded.streak,
                obs_count = excluded.obs_count,
                last_intervention_ts = excluded.last_intervention_ts,
                snoozed_until = excluded.snoozed_until,
                alignment_score = excluded.alignment_score,
                drift_latched = excluded.drift_latched,
                updated_at = excluded.updated_at
            """,
            (
                state.session_id,
                state.streak,
                state.obs_count,
                state.last_intervention_ts.isoformat() if state.last_intervention_ts else None,
                state.snoozed_until.isoformat() if state.snoozed_until else None,
                state.alignment_score,
                1 if state.drift_latched else 0,
                state.updated_at.isoformat(),
            ),
        )
        self._append_event(
            conn,
            state.session_id,
            "controller.updated",
            {
                "streak": state.streak,
                "obs_count": state.obs_count,
                "last_intervention_ts": (
                    state.last_intervention_ts.isoformat() if state.last_intervention_ts else None
                ),
                "snoozed_until": state.snoozed_until.isoformat() if state.snoozed_until else None,
                "alignment_score": state.alignment_score,
                "drift_latched": state.drift_latched,
            },
            state.updated_at,
        )

    def record_intervention_requested(
        self,
        session_id: str,
        observation_id: str,
        candidate_id: str | None = None,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "intervention.request_excerpt",
                {"observation_id": observation_id, "candidate_id": candidate_id},
                now,
            )

    def create_intervention_candidate(
        self,
        session_id: str,
        observation_id: str,
        expires_at: datetime,
        ts: datetime | None = None,
        *,
        goal_revision: int | None = None,
    ) -> tuple[InterventionCandidateRecord, bool]:
        now = ts or _utc_now()
        candidate_id = f"cand_{uuid.uuid4().hex}"
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            observation = conn.execute(
                """
                SELECT goal_revision
                FROM observations
                WHERE id = ? AND session_id = ?
                """,
                (observation_id, session_id),
            ).fetchone()
            if not observation or observation["goal_revision"] is None:
                raise ValueError("intervention candidate observation has no goal revision")
            observation_revision = int(observation["goal_revision"])
            if goal_revision is None:
                goal_revision = observation_revision
            if goal_revision != observation_revision:
                raise ValueError("intervention candidate goal revision does not match its observation")
            if self._current_goal_revision_in_conn(conn, session_id) != goal_revision:
                raise ValueError("intervention candidate goal revision is no longer current")
            self._expire_stale_intervention_candidates(conn, session_id, now)
            inserted = conn.execute(
                """
                INSERT INTO intervention_candidates (
                    id, session_id, observation_id, goal_revision, status,
                    requested_at, expires_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
                ON CONFLICT(session_id) WHERE status IN ('pending', 'in_flight')
                DO NOTHING
                """,
                (
                    candidate_id,
                    session_id,
                    observation_id,
                    goal_revision,
                    now.isoformat(),
                    expires_at.isoformat(),
                    now.isoformat(),
                ),
            )
            if inserted.rowcount == 0:
                existing = conn.execute(
                    """
                    SELECT *
                    FROM intervention_candidates
                    WHERE session_id = ? AND status IN ('pending', 'in_flight')
                    ORDER BY requested_at DESC, id DESC
                    LIMIT 1
                    """,
                    (session_id,),
                ).fetchone()
                if not existing:
                    raise RuntimeError("candidate insert conflicted without an active candidate")
                return self._intervention_candidate_from_row(existing), False

            self._append_event(
                conn,
                session_id,
                "intervention.candidate_created",
                {
                    "candidate_id": candidate_id,
                    "observation_id": observation_id,
                    "expires_at": expires_at.isoformat(),
                    "goal_revision": goal_revision,
                },
                now,
            )
            row = conn.execute(
                "SELECT * FROM intervention_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            row = self._require_intervention_candidate_row(row, candidate_id)
        return self._intervention_candidate_from_row(row), True

    def get_intervention_candidate_for_observation(
        self,
        observation_id: str,
    ) -> InterventionCandidateRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT *
                FROM intervention_candidates
                WHERE observation_id = ?
                ORDER BY requested_at DESC, id DESC
                LIMIT 1
                """,
                (observation_id,),
            ).fetchone()
        return self._intervention_candidate_from_row(row) if row else None

    def claim_intervention_candidate(
        self,
        candidate_id: str,
        ts: datetime | None = None,
    ) -> tuple[InterventionCandidateRecord | None, bool]:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            expired = conn.execute(
                """
                UPDATE intervention_candidates
                SET status = 'expired', updated_at = ?
                WHERE id = ? AND status = 'pending' AND expires_at <= ?
                """,
                (now.isoformat(), candidate_id, now.isoformat()),
            )
            if expired.rowcount == 1:
                row = conn.execute(
                    "SELECT * FROM intervention_candidates WHERE id = ?",
                    (candidate_id,),
                ).fetchone()
                row = self._require_intervention_candidate_row(row, candidate_id)
                candidate = self._intervention_candidate_from_row(row)
                self._append_event(
                    conn,
                    candidate.session_id,
                    "intervention.candidate_expired",
                    {"candidate_id": candidate.id, "observation_id": candidate.observation_id},
                    now,
                )
                return candidate, False

            claimed = conn.execute(
                """
                UPDATE intervention_candidates
                SET status = 'in_flight', updated_at = ?
                WHERE id = ? AND status = 'pending'
                """,
                (now.isoformat(), candidate_id),
            )
            row = conn.execute(
                "SELECT * FROM intervention_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            if not row:
                return None, False
            candidate = self._intervention_candidate_from_row(row)
            if claimed.rowcount != 1:
                return candidate, False
            self._append_event(
                conn,
                candidate.session_id,
                "intervention.candidate_claimed",
                {"candidate_id": candidate.id, "observation_id": candidate.observation_id},
                now,
            )
        return candidate, True

    def release_intervention_candidate(
        self,
        candidate_id: str,
        ts: datetime | None = None,
    ) -> InterventionCandidateRecord | None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT * FROM intervention_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            if not row:
                return None
            candidate = self._intervention_candidate_from_row(row)
            if candidate.status != "in_flight":
                return candidate
            next_status = "expired" if candidate.expires_at <= now else "pending"
            conn.execute(
                """
                UPDATE intervention_candidates
                SET status = ?, updated_at = ?
                WHERE id = ? AND status = 'in_flight'
                """,
                (next_status, now.isoformat(), candidate_id),
            )
            self._append_event(
                conn,
                candidate.session_id,
                "intervention.candidate_released",
                {
                    "candidate_id": candidate.id,
                    "observation_id": candidate.observation_id,
                    "status": next_status,
                },
                now,
            )
            row = conn.execute(
                "SELECT * FROM intervention_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            row = self._require_intervention_candidate_row(row, candidate_id)
        return self._intervention_candidate_from_row(row)

    def resolve_intervention_candidate(
        self,
        candidate_id: str,
        status: str,
        intervention_id: str | None = None,
        ts: datetime | None = None,
        *,
        terminal_result: dict[str, Any] | None = None,
    ) -> InterventionCandidateRecord | None:
        if status not in {"confirmed", "cancelled"}:
            raise ValueError(f"unsupported candidate resolution: {status}")
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            return self._resolve_intervention_candidate_in_conn(
                conn,
                candidate_id,
                status,
                intervention_id=intervention_id,
                terminal_result=terminal_result,
                now=now,
            )

    def _resolve_intervention_candidate_in_conn(
        self,
        conn: sqlite3.Connection,
        candidate_id: str,
        status: str,
        intervention_id: str | None,
        terminal_result: dict[str, Any] | None,
        now: datetime,
    ) -> InterventionCandidateRecord | None:
        row = conn.execute(
            "SELECT * FROM intervention_candidates WHERE id = ?",
            (candidate_id,),
        ).fetchone()
        if not row:
            return None
        candidate = self._intervention_candidate_from_row(row)
        if candidate.status == status:
            return candidate
        if candidate.status != "in_flight":
            return candidate
        conn.execute(
            """
            UPDATE intervention_candidates
            SET status = ?, intervention_id = ?, result_json = ?, updated_at = ?
            WHERE id = ? AND status = 'in_flight'
            """,
            (
                status,
                intervention_id,
                json.dumps(terminal_result, ensure_ascii=False, separators=(",", ":"))
                if terminal_result is not None
                else None,
                now.isoformat(),
                candidate_id,
            ),
        )
        if terminal_result is not None:
            confirm_drift = status == "confirmed"
            self._append_event(
                conn,
                candidate.session_id,
                "tier2.confirmed" if confirm_drift else "tier2.cancelled",
                {
                    "observation_id": candidate.observation_id,
                    "confirm_drift": confirm_drift,
                    "message": terminal_result.get("message"),
                },
                now,
            )
        self._append_event(
            conn,
            candidate.session_id,
            f"intervention.candidate_{status}",
            {
                "candidate_id": candidate.id,
                "observation_id": candidate.observation_id,
                "intervention_id": intervention_id,
            },
            now,
        )
        row = conn.execute(
            "SELECT * FROM intervention_candidates WHERE id = ?",
            (candidate_id,),
        ).fetchone()
        row = self._require_intervention_candidate_row(row, candidate_id)
        return self._intervention_candidate_from_row(row)

    def record_tier2_result(
        self,
        session_id: str,
        observation_id: str,
        confirm_drift: bool,
        message: str | None,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        event_type = "tier2.confirmed" if confirm_drift else "tier2.cancelled"
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                event_type,
                {
                    "observation_id": observation_id,
                    "confirm_drift": confirm_drift,
                    "message": message,
                },
                now,
            )

    def record_tier2_provider_error(
        self,
        session_id: str,
        observation_id: str,
        error_type: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._append_event(
                conn,
                session_id,
                "tier2.provider_error",
                {
                    "observation_id": observation_id,
                    "error_type": error_type,
                },
                now,
            )

    def create_intervention(
        self,
        session_id: str,
        observation_id: str,
        message: str,
        ts: datetime | None = None,
    ) -> str:
        now = ts or _utc_now()
        intervention_id = f"int_{uuid.uuid4().hex}"
        with self._connect() as conn:
            self._ensure_schema(conn)
            self._insert_intervention(
                conn,
                intervention_id,
                session_id,
                observation_id,
                message,
                now,
            )
        return intervention_id

    def commit_confirmed_intervention(
        self,
        candidate_id: str,
        session_id: str,
        observation_id: str,
        message: str,
        controller_state: ControllerStateRecord,
        ts: datetime | None = None,
        *,
        terminal_result: dict[str, Any] | None = None,
    ) -> str | None:
        """Atomically consume controller evidence, create an intervention, and confirm its candidate."""

        if controller_state.session_id != session_id:
            raise ValueError("controller state belongs to another session")
        now = ts or _utc_now()
        intervention_id = f"int_{uuid.uuid4().hex}"
        if terminal_result is not None:
            terminal_result = dict(terminal_result)
            terminal_result["intervention_id"] = intervention_id
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM intervention_candidates WHERE id = ?",
                (candidate_id,),
            ).fetchone()
            if not row:
                raise ValueError("intervention candidate not found")
            candidate = self._intervention_candidate_from_row(row)
            if candidate.session_id != session_id or candidate.observation_id != observation_id:
                raise ValueError("intervention candidate does not match the confirmed observation")
            if self._current_goal_revision_in_conn(conn, session_id) != candidate.goal_revision:
                if candidate.status in {"pending", "in_flight"}:
                    conn.execute(
                        """
                        UPDATE intervention_candidates
                        SET status = 'cancelled', updated_at = ?
                        WHERE id = ? AND status IN ('pending', 'in_flight')
                        """,
                        (now.isoformat(), candidate_id),
                    )
                return None

            observation = conn.execute(
                """
                SELECT observations.verdict, observations.goal_revision, page_labels.label
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.id = ? AND observations.session_id = ?
                """,
                (observation_id, session_id),
            ).fetchone()
            if not observation:
                raise ValueError("observation not found")
            if observation["goal_revision"] != candidate.goal_revision:
                raise ValueError("intervention candidate goal revision does not match its observation")
            verdict = effective_observation_verdict(observation["verdict"], observation["label"])
            if verdict != "DRIFT":
                self._cancel_active_intervention_candidates_for_observation_in_conn(
                    conn,
                    session_id,
                    observation_id,
                    now,
                )
                return None
            if candidate.status != "in_flight":
                raise ValueError(f"intervention candidate is {candidate.status}")

            self._write_controller_state(conn, controller_state)
            self._insert_intervention(
                conn,
                intervention_id,
                session_id,
                observation_id,
                message,
                now,
            )
            resolved = self._resolve_intervention_candidate_in_conn(
                conn,
                candidate_id,
                "confirmed",
                intervention_id=intervention_id,
                terminal_result=terminal_result,
                now=now,
            )
            if not resolved or resolved.status != "confirmed":
                raise RuntimeError("failed to confirm intervention candidate")
        return intervention_id

    def _insert_intervention(
        self,
        conn: sqlite3.Connection,
        intervention_id: str,
        session_id: str,
        observation_id: str,
        message: str,
        now: datetime,
    ) -> None:
        conn.execute(
            """
            INSERT INTO interventions (id, session_id, observation_id, ts, message, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (intervention_id, session_id, observation_id, now.isoformat(), message),
        )
        self._append_event(
            conn,
            session_id,
            "intervention.created",
            {
                "intervention_id": intervention_id,
                "observation_id": observation_id,
                "message": message,
            },
            now,
        )

    def get_intervention(self, intervention_id: str) -> InterventionRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT interventions.id, interventions.session_id, interventions.observation_id,
                       interventions.ts, interventions.message, interventions.status,
                       observations.tier1_reason
                FROM interventions
                LEFT JOIN observations ON observations.id = interventions.observation_id
                WHERE interventions.id = ?
                """,
                (intervention_id,),
            ).fetchone()
        return self._intervention_from_row(row) if row else None

    def update_intervention_status(
        self,
        intervention_id: str,
        status: str,
        ts: datetime | None = None,
    ) -> None:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT session_id, observation_id FROM interventions WHERE id = ?",
                (intervention_id,),
            ).fetchone()
            if not row:
                return
            conn.execute(
                "UPDATE interventions SET status = ? WHERE id = ?",
                (status, intervention_id),
            )
            self._append_event(
                conn,
                row["session_id"],
                "intervention.updated",
                {
                    "intervention_id": intervention_id,
                    "observation_id": row["observation_id"],
                    "status": status,
                },
                now,
            )

    def resolve_unhandled_interventions_for_observation(
        self,
        session_id: str,
        observation_id: str,
        status: str = "related",
        ts: datetime | None = None,
    ) -> int:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT id
                FROM interventions
                WHERE session_id = ? AND observation_id = ?
                  AND status IN ('pending', 'delivered', 'delivery_failed')
                """,
                (session_id, observation_id),
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE interventions SET status = ? WHERE id = ?",
                    (status, row["id"]),
                )
                self._append_event(
                    conn,
                    session_id,
                    "intervention.updated",
                    {
                        "intervention_id": row["id"],
                        "observation_id": observation_id,
                        "status": status,
                        "source": "page_label",
                    },
                    now,
                )
        return len(rows)

    def get_observation(self, observation_id: str) -> ObservationRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT id, session_id, ts, source, url_host, url_path_hash, title, tab_id,
                       features_json, verdict, tier_reached, tier1_reason, goal_revision
                FROM observations
                WHERE id = ?
                """,
                (observation_id,),
            ).fetchone()
        return self._observation_from_row(row) if row else None

    def latest_observation_for_tab(
        self,
        session_id: str,
        tab_id: int,
        goal_revision: int | None = None,
    ) -> ObservationRecord | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            if goal_revision is None:
                goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            row = conn.execute(
                """
                SELECT id, session_id, ts, source, url_host, url_path_hash, title, tab_id,
                       features_json, verdict, tier_reached, tier1_reason, goal_revision
                FROM observations
                WHERE session_id = ? AND tab_id = ? AND goal_revision IS ?
                ORDER BY ts DESC, id DESC
                LIMIT 1
                """,
                (session_id, tab_id, goal_revision),
            ).fetchone()
        return self._observation_from_row(row) if row else None

    def record_page_label(
        self,
        session_id: str,
        observation_id: str,
        label: str,
        exemplar_cap: int,
        ts: datetime | None = None,
    ) -> tuple[PageLabelRecord, int | None]:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            observation = conn.execute(
                """
                SELECT features_json, goal_revision
                FROM observations
                WHERE id = ? AND session_id = ?
                """,
                (observation_id, session_id),
            ).fetchone()
            if not observation:
                raise ValueError("observation not found")

            current_revision = self._current_goal_revision_in_conn(conn, session_id)
            observation_is_current = (
                observation["goal_revision"] is not None
                and int(observation["goal_revision"]) == current_revision
            )

            if label == "related":
                features = json.loads(observation["features_json"])
                emb = features.get("emb")
                if not isinstance(emb, list) or not emb:
                    raise ValueError("observation has no embedding")

            existing = conn.execute(
                "SELECT id, label FROM page_labels WHERE observation_id = ?",
                (observation_id,),
            ).fetchone()
            previous_label = existing["label"] if existing else None
            label_id = existing["id"] if existing else f"pl_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO page_labels (id, observation_id, label, ts)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(observation_id) DO UPDATE SET
                    label = excluded.label,
                    ts = excluded.ts
                """,
                (label_id, observation_id, label, now.isoformat()),
            )
            self._append_event(
                conn,
                session_id,
                "page_label.recorded",
                {
                    "label_id": label_id,
                    "observation_id": observation_id,
                    "label": label,
                    "previous_label": previous_label,
                },
                now,
            )

            if label == "related" and observation_is_current:
                self._cancel_active_intervention_candidates_for_observation_in_conn(
                    conn,
                    session_id,
                    observation_id,
                    now,
                )

            exemplar_count: int | None = None
            if label == "related" and observation_is_current:
                exemplar_count, exemplar_id = self._add_goal_exemplar_from_observation(
                    conn,
                    session_id,
                    observation_id,
                    exemplar_cap,
                    now,
                    features=features,
                )
                if exemplar_id:
                    self._append_goal_exemplar_added_event(
                        conn,
                        session_id,
                        observation_id,
                        exemplar_id,
                        exemplar_count,
                        exemplar_cap,
                        now,
                    )
            elif label == "drift":
                conn.execute(
                    "DELETE FROM goal_exemplars WHERE session_id = ? AND observation_id = ?",
                    (session_id, observation_id),
                )

        return PageLabelRecord(id=label_id, observation_id=observation_id, label=label, ts=now), exemplar_count

    def cancel_active_intervention_candidates_for_observation(
        self,
        session_id: str,
        observation_id: str,
        ts: datetime | None = None,
    ) -> int:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            return self._cancel_active_intervention_candidates_for_observation_in_conn(
                conn,
                session_id,
                observation_id,
                now,
            )

    def _cancel_active_intervention_candidates_for_observation_in_conn(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        observation_id: str,
        now: datetime,
    ) -> int:
        rows = conn.execute(
            """
            SELECT *
            FROM intervention_candidates
            WHERE session_id = ? AND observation_id = ?
              AND status IN ('pending', 'in_flight')
            """,
            (session_id, observation_id),
        ).fetchall()
        for row in rows:
            candidate = self._intervention_candidate_from_row(row)
            conn.execute(
                """
                UPDATE intervention_candidates
                SET status = 'cancelled', updated_at = ?
                WHERE id = ? AND status IN ('pending', 'in_flight')
                """,
                (now.isoformat(), candidate.id),
            )
            self._append_event(
                conn,
                candidate.session_id,
                "intervention.candidate_cancelled",
                {
                    "candidate_id": candidate.id,
                    "observation_id": candidate.observation_id,
                    "intervention_id": None,
                },
                now,
            )
        return len(rows)

    def page_label_for_observation(self, observation_id: str) -> str | None:
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT label FROM page_labels WHERE observation_id = ?",
                (observation_id,),
            ).fetchone()
        return row["label"] if row else None

    def controller_replay_timeline(self, session_id: str) -> list[ControllerReplayEvent]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            rows = conn.execute(
                """
                SELECT kind, ts, sort_order, sort_id, observation_id, verdict, features_json, label
                FROM (
                    SELECT 'observation' AS kind, observations.ts AS ts, 0 AS sort_order,
                           observations.id AS sort_id, observations.id AS observation_id,
                           observations.verdict AS verdict, observations.features_json AS features_json,
                           page_labels.label AS label
                    FROM observations
                    LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                    WHERE observations.session_id = ? AND observations.goal_revision IS ?
                    UNION ALL
                    SELECT 'intervention' AS kind, interventions.ts AS ts, 1 AS sort_order,
                           interventions.id AS sort_id, interventions.observation_id AS observation_id,
                           NULL AS verdict, NULL AS features_json, NULL AS label
                    FROM interventions
                    JOIN observations AS intervention_observations
                      ON intervention_observations.id = interventions.observation_id
                    WHERE interventions.session_id = ?
                      AND intervention_observations.goal_revision IS ?
                )
                ORDER BY ts ASC, sort_order ASC, sort_id ASC
                """,
                (session_id, goal_revision, session_id, goal_revision),
            ).fetchall()

        events: list[ControllerReplayEvent] = []
        for row in rows:
            r_final = None
            if row["features_json"]:
                features = json.loads(row["features_json"])
                value = features.get("r_final")
                if isinstance(value, (int, float)):
                    r_final = float(value)
            events.append(
                ControllerReplayEvent(
                    kind=row["kind"],
                    ts=_parse_dt(row["ts"]),
                    observation_id=row["observation_id"],
                    verdict=row["verdict"],
                    r_final=r_final,
                    label=row["label"],
                )
            )
        return events

    def record_feedback_once(
        self,
        session_id: str,
        kind: str,
        intervention_id: str,
        observation_id: str | None,
        ts: datetime | None = None,
    ) -> tuple[str, bool]:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            existing = conn.execute(
                """
                SELECT id
                FROM feedback
                WHERE intervention_id = ? AND kind = ?
                """,
                (intervention_id, kind),
            ).fetchone()
            if existing:
                return existing["id"], False

            feedback_id = f"fb_{uuid.uuid4().hex}"
            conn.execute(
                """
                INSERT INTO feedback (id, session_id, intervention_id, observation_id, kind, ts)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (feedback_id, session_id, intervention_id, observation_id, kind, now.isoformat()),
            )
            self._append_event(
                conn,
                session_id,
                "feedback.recorded",
                {
                    "feedback_id": feedback_id,
                    "intervention_id": intervention_id,
                    "observation_id": observation_id,
                    "kind": kind,
                },
                now,
            )
        return feedback_id, True

    def add_goal_exemplar_from_observation(
        self,
        session_id: str,
        observation_id: str,
        cap: int,
        ts: datetime | None = None,
    ) -> int:
        now = ts or _utc_now()
        with self._connect() as conn:
            self._ensure_schema(conn)
            count, exemplar_id = self._add_goal_exemplar_from_observation(
                conn,
                session_id,
                observation_id,
                cap,
                now,
            )
            if exemplar_id:
                self._append_goal_exemplar_added_event(
                    conn,
                    session_id,
                    observation_id,
                    exemplar_id,
                    count,
                    cap,
                    now,
                )
        return count

    def goal_exemplar_count(self, session_id: str) -> int:
        with self._connect() as conn:
            self._ensure_schema(conn)
            count = self._goal_exemplar_count(conn, session_id)
        return count

    def list_observations(self, session_id: str) -> list[ObservationRecord]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT id, session_id, ts, source, url_host, url_path_hash, title, tab_id,
                       features_json, verdict, tier_reached, tier1_reason, goal_revision
                FROM observations
                WHERE session_id = ?
                ORDER BY ts ASC, id ASC
                """,
                (session_id,),
            ).fetchall()
        return [self._observation_from_row(row) for row in rows]

    def recent_ok_embeddings(
        self,
        session_id: str,
        limit: int,
        goal_revision: int | None = None,
    ) -> list[list[float]]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            if goal_revision is None:
                goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            rows = conn.execute(
                """
                SELECT observations.features_json, page_labels.label
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                  AND observations.goal_revision IS ?
                  AND CASE page_labels.label
                        WHEN 'related' THEN 'OK'
                        WHEN 'drift' THEN 'DRIFT'
                        ELSE observations.verdict
                      END = 'OK'
                ORDER BY observations.ts DESC, observations.id DESC
                LIMIT ?
                """,
                (session_id, goal_revision, limit),
            ).fetchall()

        embeddings: list[list[float]] = []
        for row in rows:
            features = json.loads(row["features_json"])
            # Anchor admission guard: anchor-only OKs (anchor_eligible False) must
            # not steer the anchor. Rows from before the flag existed pass through.
            if features.get("anchor_eligible") is False and row["label"] != "related":
                continue
            emb = features.get("emb")
            if isinstance(emb, list):
                embeddings.append(emb)
        return list(reversed(embeddings))

    def recent_titles_for_host(self, url_host: str, limit: int = 10) -> list[str]:
        """Recent titles observed on a host (any session) — title-furniture learning."""
        if not url_host:
            return []
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT title
                FROM observations
                WHERE url_host = ? AND title IS NOT NULL AND title != ''
                ORDER BY ts DESC, id DESC
                LIMIT ?
                """,
                (url_host, limit),
            ).fetchall()
        return [row["title"] for row in rows]

    def anchor_value(
        self,
        session_id: str,
        limit: int,
        goal_revision: int | None = None,
    ) -> list[float] | None:
        embeddings = self.recent_ok_embeddings(session_id, limit, goal_revision)
        if not embeddings:
            return None
        width = len(embeddings[0])
        sums = [0.0] * width
        for emb in embeddings:
            for index, value in enumerate(emb):
                sums[index] += value
        return [value / len(embeddings) for value in sums]

    def recent_observation_summaries(
        self,
        session_id: str,
        limit: int,
        goal_revision: int | None = None,
    ) -> list[ObservationSummary]:
        with self._connect() as conn:
            self._ensure_schema(conn)
            if goal_revision is None:
                goal_revision = self._current_goal_revision_in_conn(conn, session_id)
            rows = conn.execute(
                """
                SELECT observations.title,
                       CASE page_labels.label
                         WHEN 'related' THEN 'OK'
                         WHEN 'drift' THEN 'DRIFT'
                         ELSE observations.verdict
                       END AS verdict
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                  AND observations.goal_revision IS ?
                ORDER BY observations.ts DESC, observations.id DESC
                LIMIT ?
                """,
                (session_id, goal_revision, limit),
            ).fetchall()
        return [
            ObservationSummary(title=row["title"], verdict=row["verdict"])
            for row in reversed(rows)
        ]

    def recent_verdicts(
        self,
        session_id: str,
        limit: int,
        after: datetime | None = None,
    ) -> list[str]:
        after_text = after.isoformat() if after else None
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """
                SELECT CASE page_labels.label
                         WHEN 'related' THEN 'OK'
                         WHEN 'drift' THEN 'DRIFT'
                         ELSE observations.verdict
                       END AS verdict
                FROM observations
                LEFT JOIN page_labels ON page_labels.observation_id = observations.id
                WHERE observations.session_id = ?
                  AND CASE page_labels.label
                        WHEN 'related' THEN 'OK'
                        WHEN 'drift' THEN 'DRIFT'
                        ELSE observations.verdict
                      END IS NOT NULL
                  AND (? IS NULL OR observations.ts > ?)
                ORDER BY observations.ts DESC, observations.id DESC
                LIMIT ?
                """,
                (session_id, after_text, after_text, limit),
            ).fetchall()
        return [row["verdict"] for row in reversed(rows)]

    def _report_from_rows(
        self,
        scope: str,
        session_id: str | None,
        report_date: str | None,
        started_at: datetime | None,
        ended_at: datetime | None,
        observation_rows: list[sqlite3.Row],
        intervention_rows: list[sqlite3.Row],
        feedback_rows: list[sqlite3.Row],
    ) -> SessionReportRecord:
        observations = len(observation_rows)
        ok = sum(1 for row in observation_rows if row["verdict"] == "OK")
        drift = sum(1 for row in observation_rows if row["verdict"] == "DRIFT")
        judged = ok + drift
        unjudged = observations - judged
        related_ratio = (ok / judged) if judged else None

        hourly = self._hourly_related_ratio(observation_rows)
        top_hosts = self._top_drift_hosts(observation_rows)
        longest_ok = self._longest_ok_stretch(observation_rows)
        intervention_counts = {row["status"]: int(row["n"]) for row in intervention_rows}
        feedback_counts = {row["kind"]: int(row["n"]) for row in feedback_rows}
        judgments = [
            JudgmentReasonRecord(
                observation_id=row["id"],
                ts=_parse_dt(row["ts"]),
                verdict=row["verdict"],
                url_host=row["url_host"],
                title=row["title"],
                tier_reached=row["tier_reached"],
                tier1_reason=row["tier1_reason"],
            )
            for row in observation_rows
        ]

        if started_at and ended_at:
            end_bound = ended_at
        elif started_at:
            end_bound = _utc_now()
        else:
            end_bound = None
        duration_seconds = (
            max(0, int((end_bound - started_at).total_seconds()))
            if started_at and end_bound
            else 0
        )

        return SessionReportRecord(
            scope=scope,
            session_id=session_id,
            date=report_date,
            started_at=started_at,
            ended_at=ended_at,
            duration_seconds=duration_seconds,
            observations=observations,
            ok=ok,
            drift=drift,
            unjudged=unjudged,
            related_ratio=related_ratio,
            hourly_related_ratio=hourly,
            top_drift_hosts=top_hosts,
            longest_ok_stretch=longest_ok,
            intervention_status_counts=intervention_counts,
            feedback_counts=feedback_counts,
            judgments=judgments,
        )

    def _hourly_related_ratio(self, rows: list[sqlite3.Row]) -> list[ReportHourBucketRecord]:
        buckets: dict[str, dict[str, int]] = {}
        for row in rows:
            local_hour = _parse_dt(row["ts"]).astimezone().replace(minute=0, second=0, microsecond=0)
            key = local_hour.isoformat()
            bucket = buckets.setdefault(key, {"observations": 0, "ok": 0, "drift": 0})
            bucket["observations"] += 1
            if row["verdict"] == "OK":
                bucket["ok"] += 1
            elif row["verdict"] == "DRIFT":
                bucket["drift"] += 1

        records: list[ReportHourBucketRecord] = []
        for hour in sorted(buckets):
            bucket = buckets[hour]
            judged = bucket["ok"] + bucket["drift"]
            records.append(
                ReportHourBucketRecord(
                    hour=hour,
                    observations=bucket["observations"],
                    ok=bucket["ok"],
                    drift=bucket["drift"],
                    related_ratio=(bucket["ok"] / judged) if judged else None,
                )
            )
        return records

    def _top_drift_hosts(self, rows: list[sqlite3.Row]) -> list[DriftHostRecord]:
        counts: dict[str, int] = {}
        for row in rows:
            if row["verdict"] != "DRIFT" or not row["url_host"]:
                continue
            counts[row["url_host"]] = counts.get(row["url_host"], 0) + 1
        return [
            DriftHostRecord(host=host, count=count)
            for host, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:3]
        ]

    def _longest_ok_stretch(self, rows: list[sqlite3.Row]) -> OkStretchRecord | None:
        best_start: datetime | None = None
        best_end: datetime | None = None
        current_start: datetime | None = None
        current_end: datetime | None = None

        for row in rows:
            ts = _parse_dt(row["ts"])
            if row["verdict"] == "OK":
                current_start = current_start or ts
                current_end = ts
                if best_start is None or _stretch_seconds(current_start, current_end) > _stretch_seconds(best_start, best_end):
                    best_start = current_start
                    best_end = current_end
                continue
            current_start = None
            current_end = None

        if best_start is None or best_end is None:
            return None
        return OkStretchRecord(
            start=best_start,
            end=best_end,
            minutes=max(0, int((best_end - best_start).total_seconds()) // 60),
        )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA secure_delete = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                ended_at TEXT
            );

            CREATE TABLE IF NOT EXISTS goals (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                raw_text TEXT NOT NULL,
                provenance TEXT NOT NULL CHECK (provenance = 'declared'),
                updated_at TEXT NOT NULL,
                available_time_minutes INTEGER,
                goal_revision INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS goal_exemplars (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                observation_id TEXT REFERENCES observations(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                vector_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(session_id, position)
            );

            CREATE TABLE IF NOT EXISTS goal_derived_exemplars (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                goal_revision INTEGER NOT NULL,
                position INTEGER NOT NULL,
                phrase TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(session_id, position)
            );

            CREATE TABLE IF NOT EXISTS observations (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                ts TEXT NOT NULL,
                source TEXT NOT NULL,
                url_host TEXT,
                url_path_hash TEXT,
                title TEXT,
                tab_id INTEGER,
                features_json TEXT NOT NULL DEFAULT '{}',
                verdict TEXT,
                tier_reached INTEGER,
                goal_revision INTEGER
            );

            CREATE TABLE IF NOT EXISTS observation_requests (
                idempotency_key TEXT PRIMARY KEY,
                request_fingerprint TEXT NOT NULL,
                result_json TEXT
            );

            CREATE TABLE IF NOT EXISTS observation_processing_states (
                observation_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                goal_revision INTEGER NOT NULL,
                tab_id INTEGER,
                url_host TEXT,
                url_path_hash TEXT,
                title TEXT,
                stage TEXT NOT NULL CHECK (stage IN ('tier0', 'tier1')),
                started_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS controller_states (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                streak INTEGER NOT NULL DEFAULT 0,
                obs_count INTEGER NOT NULL DEFAULT 0,
                last_intervention_ts TEXT,
                snoozed_until TEXT,
                alignment_score REAL,
                drift_latched INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS interventions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
                ts TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            );

            CREATE TABLE IF NOT EXISTS intervention_candidates (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
                goal_revision INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN ('pending', 'in_flight', 'confirmed', 'cancelled', 'expired')
                ),
                requested_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
                result_json TEXT
            );

            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                intervention_id TEXT REFERENCES interventions(id) ON DELETE SET NULL,
                observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                ts TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS event_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                session_id TEXT,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attachment_states (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                drift_started_at TEXT,
                drift_confirmed_at TEXT,
                last_celebration_ts TEXT,
                last_celebration_template TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS page_labels (
                id TEXT PRIMARY KEY,
                observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
                label TEXT NOT NULL CHECK (label IN ('related', 'drift')),
                ts TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_once_intervention_kind
            ON feedback(intervention_id, kind)
            WHERE intervention_id IS NOT NULL;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_page_labels_observation
            ON page_labels(observation_id);

            CREATE TABLE IF NOT EXISTS observation_excerpts (
                observation_id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                captured_at TEXT NOT NULL,
                text TEXT NOT NULL,
                char_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS drift_clock_states (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                active_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
                active_tab_id INTEGER,
                active_url_host TEXT,
                active_url_path_hash TEXT,
                active_verdict TEXT,
                active_since_at TEXT,
                last_heartbeat_at TEXT,
                current_page_drift_seconds INTEGER NOT NULL DEFAULT 0,
                continuous_drift_seconds INTEGER NOT NULL DEFAULT 0,
                cumulative_drift_seconds INTEGER NOT NULL DEFAULT 0,
                next_review_mode_seconds INTEGER NOT NULL DEFAULT 0,
                review_observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
                review_started_at TEXT,
                review_status TEXT NOT NULL DEFAULT 'none',
                last_defer_reason TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS d7_prepared_reviews (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
                goal_revision INTEGER NOT NULL,
                deliver_after TEXT NOT NULL,
                outcome_json TEXT,
                prepared_at TEXT
            );

            CREATE TABLE IF NOT EXISTS dwell_presence_events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
                received_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS drift_page_dwell_states (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                url_host TEXT NOT NULL,
                url_path_hash TEXT NOT NULL,
                drift_seconds INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (session_id, url_host, url_path_hash)
            );

            CREATE INDEX IF NOT EXISTS idx_observation_excerpts_session_recent
            ON observation_excerpts(session_id, captured_at DESC, observation_id DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_intervention_candidates_active_session
            ON intervention_candidates(session_id)
            WHERE status IN ('pending', 'in_flight');

            CREATE INDEX IF NOT EXISTS idx_intervention_candidates_observation
            ON intervention_candidates(observation_id, requested_at DESC);
            """
        )
        self._ensure_goal_columns(conn)
        self._ensure_observation_columns(conn)
        self._ensure_intervention_candidate_columns(conn)
        self._ensure_goal_derived_exemplar_columns(conn)
        self._ensure_controller_columns(conn)
        self._ensure_goal_exemplar_columns(conn)
        self._ensure_drift_clock_columns(conn)
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_observations_session_tab_latest
            ON observations(session_id, tab_id, ts DESC, id DESC)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_observations_session_revision_recent
            ON observations(session_id, goal_revision, ts DESC, id DESC)
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_observation_processing_page
            ON observation_processing_states(
                session_id, goal_revision, tab_id, url_host, url_path_hash, updated_at DESC
            )
            """
        )

    def _current_goal_revision_in_conn(
        self,
        conn: sqlite3.Connection,
        session_id: str,
    ) -> int | None:
        row = conn.execute(
            "SELECT goal_revision FROM goals WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return int(row["goal_revision"]) if row else None

    def _append_event(
        self,
        conn: sqlite3.Connection,
        session_id: str | None,
        event_type: str,
        payload: dict[str, Any],
        ts: datetime,
    ) -> None:
        conn.execute(
            "INSERT INTO event_log (ts, session_id, event_type, payload_json) VALUES (?, ?, ?, ?)",
            (ts.isoformat(), session_id, event_type, json.dumps(payload)),
        )

    def _expire_stale_intervention_candidates(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        now: datetime,
    ) -> None:
        in_flight_stale_before = now - INTERVENTION_CANDIDATE_IN_FLIGHT_STALE_AFTER
        expired = conn.execute(
            """
            UPDATE intervention_candidates
            SET status = 'expired', updated_at = ?
            WHERE session_id = ? AND (
                (status = 'pending' AND expires_at <= ?)
                OR (status = 'in_flight' AND updated_at <= ?)
            )
            RETURNING id, observation_id
            """,
            (
                now.isoformat(),
                session_id,
                now.isoformat(),
                in_flight_stale_before.isoformat(),
            ),
        ).fetchall()
        if not expired:
            return
        for row in expired:
            self._append_event(
                conn,
                session_id,
                "intervention.candidate_expired",
                {"candidate_id": row["id"], "observation_id": row["observation_id"]},
                now,
            )

    def _require_intervention_candidate_row(
        self,
        row: sqlite3.Row | None,
        candidate_id: str,
    ) -> sqlite3.Row:
        if row is None:
            raise RuntimeError(f"intervention candidate disappeared: {candidate_id}")
        return row

    def _goal_from_row(self, row: sqlite3.Row) -> GoalRecord:
        goal_revision = int(row["goal_revision"])
        return GoalRecord(
            session_id=row["session_id"],
            raw_text=row["raw_text"],
            exemplars=self.get_goal_exemplars(row["session_id"]),
            provenance=row["provenance"],
            updated_at=_parse_dt(row["updated_at"]),
            goal_revision=goal_revision,
            available_time_minutes=row["available_time_minutes"],
            derived_exemplars=self.get_goal_derived_exemplars(row["session_id"], goal_revision),
        )

    def _observation_from_row(self, row: sqlite3.Row) -> ObservationRecord:
        return ObservationRecord(
            id=row["id"],
            session_id=row["session_id"],
            ts=_parse_dt(row["ts"]),
            source=row["source"],
            url_host=row["url_host"],
            url_path_hash=row["url_path_hash"],
            title=row["title"],
            tab_id=row["tab_id"],
            features=json.loads(row["features_json"]),
            verdict=row["verdict"],
            tier_reached=row["tier_reached"],
            tier1_reason=row["tier1_reason"],
            goal_revision=int(row["goal_revision"]) if row["goal_revision"] is not None else None,
        )

    def _excerpt_from_row(self, row: sqlite3.Row) -> ObservationExcerptRecord:
        return ObservationExcerptRecord(
            observation_id=row["observation_id"],
            session_id=row["session_id"],
            captured_at=_parse_dt(row["captured_at"]),
            text=row["text"],
            char_count=int(row["char_count"]),
        )

    def _intervention_from_row(self, row: sqlite3.Row) -> InterventionRecord:
        return InterventionRecord(
            id=row["id"],
            session_id=row["session_id"],
            observation_id=row["observation_id"],
            ts=_parse_dt(row["ts"]),
            message=row["message"],
            status=row["status"],
            tier1_reason=row["tier1_reason"],
        )

    def _intervention_candidate_from_row(self, row: sqlite3.Row) -> InterventionCandidateRecord:
        return InterventionCandidateRecord(
            id=row["id"],
            session_id=row["session_id"],
            observation_id=row["observation_id"],
            goal_revision=int(row["goal_revision"]),
            status=row["status"],
            requested_at=_parse_dt(row["requested_at"]),
            expires_at=_parse_dt(row["expires_at"]),
            updated_at=_parse_dt(row["updated_at"]),
            intervention_id=row["intervention_id"],
            terminal_result=json.loads(row["result_json"]) if row["result_json"] else None,
        )

    def _observation_request_from_row(self, row: sqlite3.Row) -> ObservationRequestRecord:
        return ObservationRequestRecord(
            idempotency_key=row["idempotency_key"],
            request_fingerprint=row["request_fingerprint"],
            result=json.loads(row["result_json"]) if row["result_json"] else None,
        )

    def _observation_processing_state_from_row(
        self,
        row: sqlite3.Row,
    ) -> ObservationProcessingStateRecord:
        return ObservationProcessingStateRecord(
            observation_id=row["observation_id"],
            session_id=row["session_id"],
            goal_revision=int(row["goal_revision"]),
            tab_id=row["tab_id"],
            url_host=row["url_host"],
            url_path_hash=row["url_path_hash"],
            title=row["title"],
            stage=row["stage"],
            started_at=_parse_dt(row["started_at"]),
            updated_at=_parse_dt(row["updated_at"]),
        )

    def _controller_state_from_row(self, row: sqlite3.Row) -> ControllerStateRecord:
        return ControllerStateRecord(
            session_id=row["session_id"],
            streak=row["streak"],
            obs_count=row["obs_count"],
            last_intervention_ts=_parse_dt(row["last_intervention_ts"]) if row["last_intervention_ts"] else None,
            snoozed_until=_parse_dt(row["snoozed_until"]) if row["snoozed_until"] else None,
            alignment_score=row["alignment_score"],
            drift_latched=bool(row["drift_latched"]),
            updated_at=_parse_dt(row["updated_at"]),
        )

    def _ensure_drift_clock_state_row(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        now: datetime,
    ) -> sqlite3.Row:
        row = conn.execute(
            "SELECT * FROM drift_clock_states WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row:
            return row
        conn.execute(
            """
            INSERT INTO drift_clock_states (
                session_id, current_page_drift_seconds, continuous_drift_seconds,
                cumulative_drift_seconds, next_review_mode_seconds, review_status, updated_at
            )
            VALUES (?, 0, 0, 0, 0, 'none', ?)
            """,
            (session_id, now.isoformat()),
        )
        return conn.execute(
            "SELECT * FROM drift_clock_states WHERE session_id = ?",
            (session_id,),
        ).fetchone()

    def _drift_clock_state_from_row(self, row: sqlite3.Row) -> DriftClockStateRecord:
        return DriftClockStateRecord(
            session_id=row["session_id"],
            active_observation_id=row["active_observation_id"],
            active_tab_id=row["active_tab_id"],
            active_url_host=row["active_url_host"],
            active_url_path_hash=row["active_url_path_hash"],
            active_verdict=row["active_verdict"],
            active_since_at=_parse_dt(row["active_since_at"]) if row["active_since_at"] else None,
            last_heartbeat_at=_parse_dt(row["last_heartbeat_at"]) if row["last_heartbeat_at"] else None,
            current_page_drift_seconds=int(row["current_page_drift_seconds"]),
            continuous_drift_seconds=int(row["continuous_drift_seconds"]),
            cumulative_drift_seconds=int(row["cumulative_drift_seconds"]),
            next_review_mode_seconds=int(row["next_review_mode_seconds"]),
            review_observation_id=row["review_observation_id"],
            review_started_at=_parse_dt(row["review_started_at"]) if row["review_started_at"] else None,
            review_status=row["review_status"],
            last_defer_reason=row["last_defer_reason"],
            updated_at=_parse_dt(row["updated_at"]),
        )

    def _ensure_observation_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(observations)").fetchall()}
        if "tab_id" not in columns:
            conn.execute("ALTER TABLE observations ADD COLUMN tab_id INTEGER")
        if "tier1_reason" not in columns:
            conn.execute("ALTER TABLE observations ADD COLUMN tier1_reason TEXT")
        if "goal_revision" not in columns:
            conn.execute("ALTER TABLE observations ADD COLUMN goal_revision INTEGER")
            conn.execute(
                """
                UPDATE observations
                SET goal_revision = (
                    SELECT goals.goal_revision
                    FROM goals
                    WHERE goals.session_id = observations.session_id
                )
                WHERE goal_revision IS NULL
                """
            )

    def _ensure_intervention_candidate_columns(self, conn: sqlite3.Connection) -> None:
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(intervention_candidates)").fetchall()
        }
        if "result_json" not in columns:
            conn.execute("ALTER TABLE intervention_candidates ADD COLUMN result_json TEXT")
        if "goal_revision" not in columns:
            conn.execute(
                "ALTER TABLE intervention_candidates ADD COLUMN goal_revision INTEGER NOT NULL DEFAULT 1"
            )
            conn.execute(
                """
                UPDATE intervention_candidates
                SET goal_revision = COALESCE(
                    (
                        SELECT observations.goal_revision
                        FROM observations
                        WHERE observations.id = intervention_candidates.observation_id
                    ),
                    1
                )
                """
            )

    def _ensure_controller_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(controller_states)").fetchall()}
        if "alignment_score" not in columns:
            conn.execute("ALTER TABLE controller_states ADD COLUMN alignment_score REAL")
        if "drift_latched" not in columns:
            conn.execute("ALTER TABLE controller_states ADD COLUMN drift_latched INTEGER NOT NULL DEFAULT 0")

    def _ensure_goal_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(goals)").fetchall()}
        if "available_time_minutes" not in columns:
            conn.execute("ALTER TABLE goals ADD COLUMN available_time_minutes INTEGER")
        if "goal_revision" not in columns:
            conn.execute("ALTER TABLE goals ADD COLUMN goal_revision INTEGER NOT NULL DEFAULT 1")

    def _ensure_goal_derived_exemplar_columns(self, conn: sqlite3.Connection) -> None:
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(goal_derived_exemplars)").fetchall()
        }
        if "goal_revision" not in columns:
            conn.execute(
                "ALTER TABLE goal_derived_exemplars ADD COLUMN goal_revision INTEGER NOT NULL DEFAULT 1"
            )
            conn.execute(
                """
                UPDATE goal_derived_exemplars
                SET goal_revision = COALESCE(
                    (
                        SELECT goals.goal_revision
                        FROM goals
                        WHERE goals.session_id = goal_derived_exemplars.session_id
                    ),
                    1
                )
                """
            )

    def _ensure_drift_clock_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(drift_clock_states)").fetchall()}
        if "active_url_host" not in columns:
            conn.execute("ALTER TABLE drift_clock_states ADD COLUMN active_url_host TEXT")
        if "review_started_at" not in columns:
            conn.execute("ALTER TABLE drift_clock_states ADD COLUMN review_started_at TEXT")

    def _ensure_goal_exemplar_columns(self, conn: sqlite3.Connection) -> None:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(goal_exemplars)").fetchall()}
        added_observation_id = "observation_id" not in columns
        if added_observation_id:
            conn.execute(
                """
                ALTER TABLE goal_exemplars
                ADD COLUMN observation_id TEXT REFERENCES observations(id) ON DELETE CASCADE
                """
            )

        index_exists = conn.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_goal_exemplars_observation'
            """
        ).fetchone()
        if added_observation_id or not index_exists:
            self._backfill_goal_exemplar_observation_ids(conn)
            self._deduplicate_goal_exemplar_observations(conn)
            conn.execute(
                """
                DELETE FROM goal_exemplars
                WHERE observation_id IN (
                    SELECT observation_id FROM page_labels WHERE label = 'drift'
                )
                """
            )

        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_exemplars_observation
            ON goal_exemplars(session_id, observation_id)
            WHERE observation_id IS NOT NULL
            """
        )

    def _backfill_goal_exemplar_observation_ids(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            """
            SELECT session_id, payload_json
            FROM event_log
            WHERE event_type = 'goal.exemplar_added'
            ORDER BY id ASC
            """
        ).fetchall()
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            exemplar_id = payload.get("exemplar_id")
            observation_id = payload.get("observation_id")
            if not isinstance(exemplar_id, str) or not isinstance(observation_id, str):
                continue
            conn.execute(
                """
                UPDATE goal_exemplars
                SET observation_id = ?
                WHERE id = ? AND session_id = ? AND observation_id IS NULL
                  AND EXISTS (
                      SELECT 1 FROM observations
                      WHERE id = ? AND session_id = ?
                  )
                """,
                (observation_id, exemplar_id, row["session_id"], observation_id, row["session_id"]),
            )

    def _deduplicate_goal_exemplar_observations(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            """
            SELECT id, session_id, observation_id
            FROM goal_exemplars
            WHERE observation_id IS NOT NULL
            ORDER BY session_id ASC, observation_id ASC, position DESC, created_at DESC, id DESC
            """
        ).fetchall()
        seen: set[tuple[str, str]] = set()
        duplicate_ids: list[str] = []
        for row in rows:
            key = (row["session_id"], row["observation_id"])
            if key in seen:
                duplicate_ids.append(row["id"])
            else:
                seen.add(key)
        conn.executemany("DELETE FROM goal_exemplars WHERE id = ?", [(item_id,) for item_id in duplicate_ids])

    def _add_goal_exemplar_from_observation(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        observation_id: str,
        cap: int,
        now: datetime,
        *,
        features: dict[str, Any] | None = None,
    ) -> tuple[int, str | None]:
        existing = conn.execute(
            """
            SELECT id
            FROM goal_exemplars
            WHERE session_id = ? AND observation_id = ?
            """,
            (session_id, observation_id),
        ).fetchone()
        if existing:
            return self._goal_exemplar_count(conn, session_id), None

        if features is None:
            row = conn.execute(
                "SELECT features_json FROM observations WHERE id = ? AND session_id = ?",
                (observation_id, session_id),
            ).fetchone()
            if not row:
                raise ValueError("observation not found")
            features = json.loads(row["features_json"])

        emb = features.get("emb")
        if not isinstance(emb, list) or not emb:
            raise ValueError("observation has no embedding")

        max_position = conn.execute(
            "SELECT MAX(position) FROM goal_exemplars WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0]
        position = int(max_position) + 1 if max_position is not None else 0
        exemplar_id = f"gex_{uuid.uuid4().hex}"
        conn.execute(
            """
            INSERT INTO goal_exemplars (
                id, session_id, observation_id, position, vector_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (exemplar_id, session_id, observation_id, position, json.dumps(emb), now.isoformat()),
        )
        self._enforce_goal_exemplar_cap(conn, session_id, max(1, cap))
        survived = conn.execute(
            "SELECT 1 FROM goal_exemplars WHERE id = ?",
            (exemplar_id,),
        ).fetchone()
        return self._goal_exemplar_count(conn, session_id), exemplar_id if survived else None

    def _append_goal_exemplar_added_event(
        self,
        conn: sqlite3.Connection,
        session_id: str,
        observation_id: str,
        exemplar_id: str,
        exemplar_count: int,
        cap: int,
        now: datetime,
    ) -> None:
        self._append_event(
            conn,
            session_id,
            "goal.exemplar_added",
            {
                "observation_id": observation_id,
                "exemplar_id": exemplar_id,
                "exemplar_count": exemplar_count,
                "cap": max(1, cap),
            },
            now,
        )

    def _goal_exemplar_count(self, conn: sqlite3.Connection, session_id: str) -> int:
        count = conn.execute(
            "SELECT COUNT(*) FROM goal_exemplars WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0]
        return int(count)

    def _enforce_goal_exemplar_cap(self, conn: sqlite3.Connection, session_id: str, cap: int) -> None:
        rows = conn.execute(
            """
            SELECT id, position
            FROM goal_exemplars
            WHERE session_id = ?
            ORDER BY position ASC
            """,
            (session_id,),
        ).fetchall()
        excess = len(rows) - cap
        if excess <= 0:
            return

        removable = [row for row in rows if row["position"] != 0]
        if len(removable) < excess:
            removable = rows
        delete_ids = [row["id"] for row in removable[:excess]]
        conn.executemany("DELETE FROM goal_exemplars WHERE id = ?", [(item_id,) for item_id in delete_ids])

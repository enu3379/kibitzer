import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from apps.server.app.storage.sqlite import NoActiveSessionError, SQLiteStore


class SQLiteStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        self.store.initialize()

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_create_session_marks_only_latest_active(self) -> None:
        first = self.store.create_session()
        second = self.store.create_session()

        current = self.store.get_current_session()

        self.assertIsNotNone(current)
        self.assertEqual(current.session.id, second.id)
        with closing(sqlite3.connect(self.db_path)) as conn:
            active_count = conn.execute("SELECT COUNT(*) FROM sessions WHERE active = 1").fetchone()[0]
            first_active = conn.execute("SELECT active FROM sessions WHERE id = ?", (first.id,)).fetchone()[0]
        self.assertEqual(active_count, 1)
        self.assertEqual(first_active, 0)

    def test_set_current_goal_requires_session(self) -> None:
        with self.assertRaises(NoActiveSessionError):
            self.store.set_current_goal("write the paper")

    def test_set_current_goal_upserts_declared_goal(self) -> None:
        session = self.store.create_session()
        first = self.store.set_current_goal("  write the paper  ", ["paper"])
        second = self.store.set_current_goal("revise the talk", ["slides"])
        unchanged = self.store.set_current_goal("revise the talk", ["slides"])
        current = self.store.get_current_session()

        self.assertEqual(first.session_id, session.id)
        self.assertEqual(first.raw_text, "write the paper")
        self.assertEqual(second.raw_text, "revise the talk")
        self.assertEqual(second.provenance, "declared")
        self.assertEqual((first.goal_revision, second.goal_revision), (1, 2))
        self.assertEqual(unchanged.goal_revision, second.goal_revision)
        self.assertEqual(current.goal.raw_text, "revise the talk")
        self.assertEqual(current.goal.keywords, ["slides"])

        with closing(sqlite3.connect(self.db_path)) as conn:
            goals = conn.execute("SELECT COUNT(*) FROM goals WHERE session_id = ?", (session.id,)).fetchone()[0]
            goal_events = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE session_id = ? AND event_type = 'goal.declared'",
                (session.id,),
            ).fetchone()[0]
        self.assertEqual(goals, 1)
        self.assertEqual(goal_events, 3)

    def test_latest_observation_index_supports_filter_and_order(self) -> None:
        with closing(sqlite3.connect(self.db_path)) as conn:
            index_rows = conn.execute(
                "PRAGMA index_xinfo(idx_observations_session_tab_latest)"
            ).fetchall()
            query_plan = conn.execute(
                """
                EXPLAIN QUERY PLAN
                SELECT id
                FROM observations
                WHERE session_id = ? AND tab_id = ?
                ORDER BY ts DESC, id DESC
                LIMIT 1
                """,
                ("sess_test", 1),
            ).fetchall()

        indexed_columns = [(row[2], row[3]) for row in index_rows if row[5] == 1]
        self.assertEqual(
            indexed_columns,
            [("session_id", 0), ("tab_id", 0), ("ts", 1), ("id", 1)],
        )
        self.assertIn(
            "USING COVERING INDEX idx_observations_session_tab_latest",
            " ".join(row[3] for row in query_plan),
        )

    def test_initialize_backfills_and_deduplicates_exemplar_provenance(self) -> None:
        legacy_path = Path(self.tmpdir.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as conn:
            conn.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    ended_at TEXT
                );
                CREATE TABLE goal_exemplars (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    vector_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(session_id, position)
                );
                CREATE TABLE observations (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    source TEXT NOT NULL,
                    url_host TEXT,
                    url_path_hash TEXT,
                    title TEXT,
                    features_json TEXT NOT NULL DEFAULT '{}',
                    verdict TEXT,
                    tier_reached INTEGER
                );
                CREATE TABLE event_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    session_id TEXT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE page_labels (
                    id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL,
                    label TEXT NOT NULL,
                    ts TEXT NOT NULL
                );
                """
            )
            conn.execute(
                "INSERT INTO sessions (id, created_at, active) VALUES ('sess_legacy', '2026-07-08T00:00:00+00:00', 1)"
            )
            conn.execute(
                """
                INSERT INTO observations (
                    id, session_id, ts, source, features_json, verdict, tier_reached
                )
                VALUES ('obs_legacy', 'sess_legacy', '2026-07-08T00:00:01+00:00',
                        'browser_nav', '{"emb": [0.5]}', 'DRIFT', 0)
                """
            )
            conn.executemany(
                """
                INSERT INTO goal_exemplars (id, session_id, position, vector_json, created_at)
                VALUES (?, 'sess_legacy', ?, '[0.5]', ?)
                """,
                [
                    ("gex_seed", 0, "2026-07-08T00:00:00+00:00"),
                    ("gex_old", 1, "2026-07-08T00:00:02+00:00"),
                    ("gex_new", 2, "2026-07-08T00:00:03+00:00"),
                ],
            )
            for event_id, exemplar_id in enumerate(("gex_old", "gex_new"), start=1):
                conn.execute(
                    """
                    INSERT INTO event_log (ts, session_id, event_type, payload_json)
                    VALUES (?, 'sess_legacy', 'goal.exemplar_added', ?)
                    """,
                    (
                        f"2026-07-08T00:00:0{event_id + 1}+00:00",
                        json.dumps(
                            {
                                "observation_id": "obs_legacy",
                                "exemplar_id": exemplar_id,
                            }
                        ),
                    ),
                )
            conn.execute(
                """
                INSERT INTO page_labels (id, observation_id, label, ts)
                VALUES ('pl_legacy', 'obs_legacy', 'related', '2026-07-08T00:00:04+00:00')
                """
            )
            conn.commit()

        SQLiteStore(legacy_path).initialize()

        with closing(sqlite3.connect(legacy_path)) as conn:
            exemplar_columns = {
                row[1] for row in conn.execute("PRAGMA table_info(goal_exemplars)").fetchall()
            }
            observation_columns = {
                row[1] for row in conn.execute("PRAGMA table_info(observations)").fetchall()
            }
            learned = conn.execute(
                """
                SELECT id, observation_id
                FROM goal_exemplars
                WHERE observation_id IS NOT NULL
                """
            ).fetchall()
            indexes = {
                row[1] for row in conn.execute("PRAGMA index_list(observations)").fetchall()
            }

        self.assertIn("observation_id", exemplar_columns)
        self.assertIn("tab_id", observation_columns)
        self.assertEqual(learned, [("gex_new", "obs_legacy")])
        self.assertIn("idx_observations_session_tab_latest", indexes)

    def test_initialize_adds_idempotency_storage_to_existing_candidate_schema(self) -> None:
        legacy_path = Path(self.tmpdir.name) / "candidate-legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as conn:
            conn.execute(
                """
                CREATE TABLE intervention_candidates (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    observation_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'in_flight', 'confirmed', 'cancelled', 'expired')
                    ),
                    requested_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    intervention_id TEXT
                )
                """
            )

        SQLiteStore(legacy_path).initialize()

        with closing(sqlite3.connect(legacy_path)) as conn:
            candidate_columns = {
                row[1] for row in conn.execute("PRAGMA table_info(intervention_candidates)")
            }
            request_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'observation_requests'"
            ).fetchone()
        self.assertIn("result_json", candidate_columns)
        self.assertIn("goal_revision", candidate_columns)
        self.assertIsNotNone(request_table)

    def test_initialize_backfills_goal_revision_across_legacy_goal_scoped_rows(self) -> None:
        legacy_path = Path(self.tmpdir.name) / "revision-legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as conn:
            conn.executescript(
                """
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    ended_at TEXT
                );
                CREATE TABLE goals (
                    session_id TEXT PRIMARY KEY,
                    raw_text TEXT NOT NULL,
                    keywords_json TEXT NOT NULL DEFAULT '[]',
                    provenance TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    available_time_minutes INTEGER
                );
                CREATE TABLE observations (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    source TEXT NOT NULL,
                    url_host TEXT,
                    url_path_hash TEXT,
                    title TEXT,
                    features_json TEXT NOT NULL DEFAULT '{}',
                    verdict TEXT,
                    tier_reached INTEGER
                );
                CREATE TABLE goal_derived_exemplars (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    phrase TEXT NOT NULL,
                    vector_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(session_id, position)
                );
                CREATE TABLE intervention_candidates (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    observation_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    requested_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    intervention_id TEXT,
                    result_json TEXT
                );
                INSERT INTO sessions VALUES ('sess_legacy', '2026-07-08T00:00:00+00:00', 1, NULL);
                INSERT INTO goals VALUES (
                    'sess_legacy', 'legacy goal', '[]', 'declared',
                    '2026-07-08T00:00:00+00:00', NULL
                );
                INSERT INTO observations VALUES (
                    'obs_legacy', 'sess_legacy', '2026-07-08T00:00:01+00:00',
                    'browser_nav', 'example.com', 'hash', 'Legacy page',
                    '{"emb":[1.0]}', 'DRIFT', 0
                );
                INSERT INTO goal_derived_exemplars VALUES (
                    'gdex_legacy', 'sess_legacy', 0, 'legacy phrase', '[1.0]',
                    '2026-07-08T00:00:02+00:00'
                );
                INSERT INTO intervention_candidates VALUES (
                    'cand_legacy', 'sess_legacy', 'obs_legacy', 'pending',
                    '2026-07-08T00:00:03+00:00', '2026-07-08T00:10:00+00:00',
                    '2026-07-08T00:00:03+00:00', NULL, NULL
                );
                """
            )

        SQLiteStore(legacy_path).initialize()

        with closing(sqlite3.connect(legacy_path)) as conn:
            revisions = (
                conn.execute("SELECT goal_revision FROM goals").fetchone()[0],
                conn.execute("SELECT goal_revision FROM observations").fetchone()[0],
                conn.execute("SELECT goal_revision FROM goal_derived_exemplars").fetchone()[0],
                conn.execute("SELECT goal_revision FROM intervention_candidates").fetchone()[0],
            )
        self.assertEqual(revisions, (1, 1, 1, 1))


if __name__ == "__main__":
    unittest.main()

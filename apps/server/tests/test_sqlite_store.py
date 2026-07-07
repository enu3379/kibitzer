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
        current = self.store.get_current_session()

        self.assertEqual(first.session_id, session.id)
        self.assertEqual(first.raw_text, "write the paper")
        self.assertEqual(second.raw_text, "revise the talk")
        self.assertEqual(second.provenance, "declared")
        self.assertEqual(current.goal.raw_text, "revise the talk")
        self.assertEqual(current.goal.keywords, ["slides"])

        with closing(sqlite3.connect(self.db_path)) as conn:
            goals = conn.execute("SELECT COUNT(*) FROM goals WHERE session_id = ?", (session.id,)).fetchone()[0]
            goal_events = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE session_id = ? AND event_type = 'goal.declared'",
                (session.id,),
            ).fetchone()[0]
        self.assertEqual(goals, 1)
        self.assertEqual(goal_events, 2)


if __name__ == "__main__":
    unittest.main()

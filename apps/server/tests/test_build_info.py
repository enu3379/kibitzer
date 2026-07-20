import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.server.tests.support import TestClient

from apps.server.app import build_info
from apps.server.app.config import AppConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore
from apps.server.app.version import APP_VERSION


class GitCommitTest(unittest.TestCase):
    def setUp(self) -> None:
        build_info.git_commit.cache_clear()
        self.addCleanup(build_info.git_commit.cache_clear)

    def test_marks_commit_dirty_when_tracked_changes_exist(self) -> None:
        def fake_run_git(*args: str) -> str | None:
            if args[0] == "rev-parse":
                return "abc1234"
            return " M apps/server/app/main.py"

        with patch.object(build_info, "_run_git", side_effect=fake_run_git):
            self.assertEqual(build_info.git_commit(), "abc1234+dirty")

    def test_reports_plain_commit_when_tree_is_clean(self) -> None:
        def fake_run_git(*args: str) -> str | None:
            if args[0] == "rev-parse":
                return "abc1234"
            return ""

        with patch.object(build_info, "_run_git", side_effect=fake_run_git):
            self.assertEqual(build_info.git_commit(), "abc1234")

    def test_returns_none_outside_git_checkout(self) -> None:
        with patch.object(build_info, "_run_git", return_value=None):
            self.assertIsNone(build_info.git_commit())


class BuildInfoEndpointsTest(unittest.TestCase):
    def test_health_and_identity_expose_build_info(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            config = AppConfig(
                server=ServerConfig(db_path=str(db_path)),
                tier1=Tier1Config(enabled=False),
                tier2=Tier2Config(enabled=False),
            )
            with TestClient(
                create_app(
                    config=config,
                    store=SQLiteStore(db_path),
                    instance_id="known-instance",
                )
            ) as client:
                health = client.get("/health").json()
                identity = client.get("/identity").json()

        for payload in (health, identity):
            self.assertEqual(payload["version"], APP_VERSION)
            self.assertIn("git_commit", payload)
            self.assertEqual(payload["started_at"], build_info.SERVER_STARTED_AT)


if __name__ == "__main__":
    unittest.main()

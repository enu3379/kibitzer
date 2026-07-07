import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    DeliveryConfig,
    QuietHoursConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
    VoiceConfig,
)
from apps.server.app.main import create_app
from apps.server.app.storage.sqlite import SQLiteStore


class SettingsApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
            delivery=DeliveryConfig(
                persona="dry_kibitzer",
                voice=VoiceConfig(enabled=False, voice="Yuna", rate=175),
                quiet_hours=QuietHoursConfig(enabled=False, start="09:00", end="18:00"),
            ),
        )
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_settings_defaults_and_roundtrip(self) -> None:
        defaults = self.client.get("/settings").json()
        self.assertEqual(defaults["persona"], "dry_kibitzer")
        self.assertFalse(defaults["voice_enabled"])
        self.assertEqual(defaults["cooldown"], {"enabled": False, "seconds": 0})
        self.assertEqual(defaults["quiet_hours"], {"enabled": False, "start": "09:00", "end": "18:00"})

        updated = self.client.put(
            "/settings",
            json={
                "persona": "quiet_coach",
                "voice_enabled": True,
                "cooldown": {"enabled": True, "seconds": 30},
                "quiet_hours": {"enabled": True, "start": "22:30", "end": "07:15"},
            },
        ).json()

        self.assertEqual(updated["persona"], "quiet_coach")
        self.assertTrue(updated["voice_enabled"])
        self.assertEqual(updated["cooldown"], {"enabled": True, "seconds": 30})
        self.assertEqual(updated["quiet_hours"], {"enabled": True, "start": "22:30", "end": "07:15"})
        self.assertEqual(self.client.get("/settings").json(), updated)

        with sqlite3.connect(self.db_path) as conn:
            event = conn.execute(
                "SELECT payload_json FROM event_log WHERE event_type = 'settings.updated'"
            ).fetchone()[0]
        self.assertEqual(json.loads(event)["keys"], ["cooldown", "persona", "quiet_hours", "voice_enabled"])

    def test_settings_validation(self) -> None:
        self.assertEqual(self.client.put("/settings", json={"persona": "missing"}).status_code, 400)
        self.assertEqual(
            self.client.put("/settings", json={"quiet_hours": {"start": "25:00"}}).status_code,
            422,
        )
        self.assertEqual(
            self.client.put("/settings", json={"cooldown": {"seconds": -1}}).status_code,
            422,
        )


if __name__ == "__main__":
    unittest.main()

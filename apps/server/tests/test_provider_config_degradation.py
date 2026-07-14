import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from apps.server.app.config import (
    AppConfig,
    GoalEnrichmentConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.main import create_app
from apps.server.app.providers.judges.base import Tier1Result, Tier2Result
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class HealthyJudgeProvider:
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.OK, reason="healthy tier")

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        return '{"phrases":[]}'

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        return Tier2Result(confirm_drift=False, message=None)


class ProviderConfigDegradationTest(unittest.TestCase):
    def test_invalid_tier1_config_degrades_only_tier1_and_keeps_requests_alive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            models_path = root / "models.local.yaml"
            db_path = root / "kibitzer.sqlite3"
            models_path.write_text(
                yaml.safe_dump(
                    {
                        "broken": {
                            "api_url": "http://localhost:11434/v1/chat/completions",
                            "api_style": "not-a-provider",
                            "model_name": "test-model",
                            "api_key": "super-secret-key",
                        }
                    }
                ),
                encoding="utf-8",
            )
            config = AppConfig(
                server=ServerConfig(db_path=str(db_path)),
                goal_enrichment=GoalEnrichmentConfig(enabled=False),
                tier1=Tier1Config(
                    enabled=True,
                    provider="experiment",
                    experiment_models_file=str(models_path),
                    experiment_model_key="broken",
                ),
                tier2=Tier2Config(enabled=True),
            )
            store = SQLiteStore(db_path)

            with TestClient(
                create_app(config=config, store=store, tier2_provider=HealthyJudgeProvider())
            ) as client:
                self.assertEqual(client.post("/sessions").status_code, 201)
                with self.assertLogs("kibitzer", level="WARNING") as captured:
                    goal_response = client.post(
                        "/sessions/current/goal",
                        json={"raw_text": "Kibitzer observation API"},
                    )
                self.assertEqual(goal_response.status_code, 200)
                log_output = "\n".join(captured.output)
                self.assertIn("field=api_style", log_output)
                self.assertIn("error_type=ValueError", log_output)
                self.assertNotIn("super-secret-key", log_output)

                first_nav = self._post_browser_nav(client, "Sourdough bread recipe")
                self.assertEqual(first_nav.status_code, 200)

                client.app.state.runtime.enter_idle("test repeated activation")
                second_nav = self._post_browser_nav(client, "Another bread recipe")
                self.assertEqual(second_nav.status_code, 200)

                self.assertEqual(
                    client.get("/health").json()["tiers"],
                    {"tier1": "degraded", "tier2": "active"},
                )

            self.assertEqual(
                self._degraded_events(db_path),
                [{"tier": 1, "reason": "config_invalid"}],
            )

    def test_invalid_tier2_fields_degrade_only_tier2_once(self) -> None:
        cases = (
            ("api_style", "not-a-provider", "api_style", "ValueError"),
            ("timeout_sec", "120 seconds", "timeout_sec", "ValueError"),
            ("max_output_tokens", "640 tokens", "max_output_tokens", "ValueError"),
        )
        for case_name, invalid_value, expected_field, expected_error_type in cases:
            with self.subTest(field=case_name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                models_path = root / "models.local.yaml"
                db_path = root / "kibitzer.sqlite3"
                entry: dict[str, object] = {
                    "api_url": "http://localhost:11434/v1/chat/completions",
                    "api_style": "openai",
                    "model_name": "test-model",
                    "api_key": "super-secret-key",
                    "timeout_sec": 12,
                    "max_output_tokens": 128,
                }
                entry[case_name] = invalid_value
                models_path.write_text(
                    yaml.safe_dump({"broken": entry}),
                    encoding="utf-8",
                )
                config = AppConfig(
                    server=ServerConfig(db_path=str(db_path)),
                    goal_enrichment=GoalEnrichmentConfig(enabled=False),
                    tier1=Tier1Config(enabled=True),
                    tier2=Tier2Config(
                        enabled=True,
                        provider="experiment",
                        experiment_models_file=str(models_path),
                        experiment_model_key="broken",
                    ),
                )
                store = SQLiteStore(db_path)

                with TestClient(
                    create_app(config=config, store=store, tier1_provider=HealthyJudgeProvider())
                ) as client:
                    self.assertEqual(client.post("/sessions").status_code, 201)
                    with self.assertLogs("kibitzer", level="WARNING") as captured:
                        goal_response = client.post(
                            "/sessions/current/goal",
                            json={"raw_text": "Kibitzer observation API"},
                        )
                    self.assertEqual(goal_response.status_code, 200)
                    log_output = "\n".join(captured.output)
                    self.assertIn(f"field={expected_field}", log_output)
                    self.assertIn(f"error_type={expected_error_type}", log_output)
                    self.assertNotIn("super-secret-key", log_output)

                    client.app.state.runtime.enter_idle("test repeated activation")
                    nav_response = self._post_browser_nav(client, f"{case_name} still works")
                    self.assertEqual(nav_response.status_code, 200)
                    self.assertEqual(
                        client.get("/health").json()["tiers"],
                        {"tier1": "active", "tier2": "degraded"},
                    )

                self.assertEqual(
                    self._degraded_events(db_path),
                    [{"tier": 2, "reason": "config_invalid"}],
                )

    @staticmethod
    def _post_browser_nav(client: TestClient, title: str):
        return client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {"url": "https://example.com/page", "title": title},
            },
        )

    @staticmethod
    def _degraded_events(db_path: Path) -> list[dict[str, object]]:
        with closing(sqlite3.connect(db_path)) as conn:
            rows = conn.execute(
                "SELECT payload_json FROM event_log "
                "WHERE event_type = 'provider.degraded' ORDER BY id"
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

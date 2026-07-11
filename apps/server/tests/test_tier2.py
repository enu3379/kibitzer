import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx
import yaml
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
from apps.server.app.providers.judges.base import Tier1Result, Tier2Result
from apps.server.app.providers.judges.factory import create_tier2_judge_provider
from apps.server.app.providers.judges.ollama_chat import OllamaChatJudgeProvider
from apps.server.app.providers.judges.openai_compatible import parse_tier2_json
from apps.server.app.schemas import Observation, ObservationFeatures, Source, Verdict
from apps.server.app.storage.sqlite import SQLiteStore


@dataclass
class FakeTier2Provider:
    result: Tier2Result
    payloads: list[dict[str, object]] = field(default_factory=list)
    system_prompts: list[str | None] = field(default_factory=list)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        self.payloads.append(payload)
        self.system_prompts.append(system_prompt)
        return self.result


class RaisingTier2Provider:
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        return Tier1Result(verdict=Verdict.DRIFT, reason="unused")

    async def confirm_tier2(
        self,
        payload: dict[str, object],
        system_prompt: str | None = None,
    ) -> Tier2Result:
        request = httpx.Request("POST", "https://provider.invalid/chat")
        raise httpx.ConnectError("offline", request=request)


class Tier2ProviderTest(unittest.TestCase):
    def test_parse_tier2_json_accepts_confirm_and_cancel(self) -> None:
        confirm = parse_tier2_json('{"confirm_drift":true,"message":"목표에서 벗어났습니다."}')
        cancel = parse_tier2_json('{"confirm_drift":false,"message":""}')
        fenced = parse_tier2_json('```json\n{"confirm_drift":true,"message":"다른 흐름입니다."}\n```')

        self.assertTrue(confirm.confirm_drift)
        self.assertEqual(confirm.message, "목표에서 벗어났습니다.")
        self.assertFalse(cancel.confirm_drift)
        self.assertEqual(fenced.message, "다른 흐름입니다.")

    def test_parse_tier2_json_rejects_non_boolean_confirm(self) -> None:
        with self.assertRaises(ValueError):
            parse_tier2_json('{"confirm_drift":"yes","message":"bad"}')

    def test_factory_reads_ollama_experiment_model_without_copying_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            models_file = Path(tmp) / "models.yaml"
            models_file.write_text(
                yaml.safe_dump(
                    {
                        "ollama_free": {
                            "api_url": "https://ollama.com/api/chat",
                            "api_style": "ollama",
                            "model_name": "qwen3.5:27b",
                            "timeout_sec": 12,
                            "max_output_tokens": 128,
                            "api_key": "primary-test-key",
                            "fallback_api_key": "fallback-test-key",
                        }
                    }
                )
            )

            provider = create_tier2_judge_provider(
                Tier2Config(
                    provider="experiment",
                    experiment_models_file=str(models_file),
                    experiment_model_key="ollama_free",
                )
            )

        self.assertIsInstance(provider, OllamaChatJudgeProvider)
        assert isinstance(provider, OllamaChatJudgeProvider)
        self.assertEqual(provider.model, "qwen3.5:27b")
        self.assertEqual(provider.api_url, "https://ollama.com/api/chat")
        self.assertEqual(provider.timeout_seconds, 12)


class Tier2ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        provider: FakeTier2Provider | None,
        tier2_enabled: bool = True,
        delivery: DeliveryConfig | None = None,
    ) -> tuple[TestClient, SQLiteStore]:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=tier2_enabled, excerpt_char_limit=120, recent_observations=3),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
            delivery=delivery or DeliveryConfig(),
        )
        client = TestClient(create_app(config=config, store=store, tier2_provider=provider))
        client.__enter__()
        return client, store

    def _start_goal_and_request_excerpt(self, client: TestClient) -> dict[str, object]:
        client.post("/sessions")
        client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/bread?secret=not-stored",
                    "title": "Sourdough bread recipe",
                },
            },
        )
        result = response.json()
        self.assertEqual(result["action"], "request_excerpt")
        return result

    def test_excerpt_confirmed_creates_notify_and_intervention_without_storing_excerpt(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="지금 페이지는 목표와 달라 보여요. 계속 볼까요?"))
        client, _store = self._client(provider)
        secret_excerpt = "DO_NOT_PERSIST_SECRET_EXCERPT"
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": f"{secret_excerpt} " + ("bread " * 100)},
            )
            provider_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertEqual(result["action"], "notify")
        self.assertEqual(result["message"], "지금 페이지는 목표와 달라 보여요. 계속 볼까요?")
        self.assertTrue(result["intervention_id"].startswith("int_"))
        self.assertEqual(len(provider.payloads), 1)
        self.assertEqual(provider_status["last_result"], "success")
        self.assertIsNone(provider_status["reason"])
        payload = provider.payloads[0]
        self.assertLessEqual(len(str(payload["page_excerpt"])), 120)
        self.assertEqual(payload["current"]["url_host"], "example.com")
        self.assertNotIn("secret=not-stored", json.dumps(payload))

        with closing(sqlite3.connect(self.db_path)) as conn:
            events = "\n".join(row[0] for row in conn.execute("SELECT payload_json FROM event_log").fetchall())
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
        self.assertEqual(intervention_count, 1)
        self.assertNotIn(secret_excerpt, events)

    def test_tier2_can_cancel_false_positive_drift(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=False, message=""))
        client, _store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "API design", "text": "This bread page is actually an API example about breadcrumbs."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "none")
        with closing(sqlite3.connect(self.db_path)) as conn:
            intervention_count = conn.execute("SELECT COUNT(*) FROM interventions").fetchone()[0]
            cancelled = conn.execute("SELECT COUNT(*) FROM event_log WHERE event_type = 'tier2.cancelled'").fetchone()[0]
        self.assertEqual(intervention_count, 0)
        self.assertEqual(cancelled, 1)

    def test_missing_provider_falls_back_to_local_message(self) -> None:
        client, _store = self._client(None, tier2_enabled=False)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertEqual(result["action"], "notify")
        self.assertIn("Kibitzer observation API", result["message"])
        with closing(sqlite3.connect(self.db_path)) as conn:
            confirmed = conn.execute("SELECT COUNT(*) FROM event_log WHERE event_type = 'tier2.confirmed'").fetchone()[0]
        self.assertEqual(confirmed, 1)

    def test_provider_failure_is_reported_in_health(self) -> None:
        client, _store = self._client(RaisingTier2Provider())
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
            provider_status = client.get("/health").json()["provider_calls"]["tier2"]
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "notify")
        self.assertEqual(provider_status["last_result"], "error")
        self.assertEqual(provider_status["reason"], "connection")

    def test_tier2_provider_receives_persona_prompt_and_escalation_context(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        client, store = self._client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            store.record_observation(
                Observation(
                    id=f"obs_{uuid.uuid4().hex}",
                    ts=datetime.now(timezone.utc),
                    session_id=session_id,
                    source=Source.BROWSER_NAV,
                    payload={"url_host": "docs.example.com", "title": "API docs"},
                    features=ObservationFeatures(emb=[0.5], r0=0.9, tier_reached=0),
                    verdict=Verdict.OK,
                )
            )
            previous = store.record_observation(
                Observation(
                    id=f"obs_{uuid.uuid4().hex}",
                    ts=datetime.now(timezone.utc),
                    session_id=session_id,
                    source=Source.BROWSER_NAV,
                    payload={"url_host": "example.com", "title": "Old bread page"},
                    features=ObservationFeatures(emb=[0.1], r0=0.0, tier_reached=0),
                    verdict=Verdict.DRIFT,
                )
            )
            intervention_id = store.create_intervention(session_id, previous.id, "Old drift.")
            store.update_intervention_status(intervention_id, "delivered")

            request = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/bread",
                        "title": "Sourdough bread recipe",
                    },
                },
            ).json()
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "Unrelated bread recipe."},
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "notify")
        self.assertEqual(len(provider.payloads), 1)
        self.assertIn("Return strict JSON only", provider.system_prompts[0])
        self.assertIn("Persona style layer", provider.system_prompts[0])
        context = provider.payloads[0]["nagging_context"]
        self.assertEqual(context["nag_count_today"], 1)
        self.assertTrue(context["last_nag_ignored"])
        self.assertTrue(context["repeat_host"])
        self.assertIsNotNone(context["drift_minutes"])

    def test_quiet_hours_marks_notify_silent_and_records_suppression(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="조용히 기록만 합니다."))
        delivery = DeliveryConfig(
            quiet_hours=QuietHoursConfig(enabled=True, start="00:00", end="00:00"),
        )
        client, _store = self._client(provider, delivery=delivery)
        try:
            request = self._start_goal_and_request_excerpt(client)
            response = client.post(
                f"/observations/{request['observation_id']}/excerpt",
                json={"title": "Bread", "text": "A recipe with unrelated steps."},
            )
        finally:
            client.__exit__(None, None, None)

        result = response.json()
        self.assertTrue(result["silent"])
        with closing(sqlite3.connect(self.db_path)) as conn:
            suppressed = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'delivery.suppressed_quiet_hours'"
            ).fetchone()[0]
            voice = conn.execute(
                "SELECT COUNT(*) FROM event_log WHERE event_type = 'delivery.voice_spoken'"
            ).fetchone()[0]
        self.assertEqual(suppressed, 1)
        self.assertEqual(voice, 0)

    def test_voice_is_disabled_by_default_and_invoked_when_enabled(self) -> None:
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        client, _store = self._client(provider)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch("apps.server.app.api.observations.speak") as speak_mock:
                client.post(
                    f"/observations/{request['observation_id']}/excerpt",
                    json={"title": "Bread", "text": "A recipe with unrelated steps."},
                )
                speak_mock.assert_not_called()
        finally:
            client.__exit__(None, None, None)

        self.db_path.unlink()
        provider = FakeTier2Provider(Tier2Result(confirm_drift=True, message="목표와 다른 페이지입니다."))
        delivery = DeliveryConfig(voice=VoiceConfig(enabled=True, voice="Alex", rate=150))
        client, _store = self._client(provider, delivery=delivery)
        try:
            request = self._start_goal_and_request_excerpt(client)
            with patch("apps.server.app.api.observations.speak") as speak_mock:
                client.post(
                    f"/observations/{request['observation_id']}/excerpt",
                    json={"title": "Bread", "text": "A recipe with unrelated steps."},
                )
                speak_mock.assert_called_once()
        finally:
            client.__exit__(None, None, None)


if __name__ == "__main__":
    unittest.main()

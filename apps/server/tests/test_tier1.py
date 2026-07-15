import asyncio
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    GoalEnrichmentConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.core.tier1_payload import build_tier1_payload
from apps.server.app.main import create_app
from apps.server.app.providers.judges.base import Tier1Result
from apps.server.app.providers.judges.factory import create_tier1_judge_provider
from apps.server.app.providers.judges.ollama_chat import OllamaChatJudgeProvider
from apps.server.app.providers.judges.openai_compatible import parse_tier1_json
from apps.server.app.schemas import Observation, Source, Verdict
from apps.server.app.storage.sqlite import ObservationSummary, SQLiteStore


@dataclass
class FakeTier1Provider:
    result: Tier1Result
    payloads: list[dict[str, object]] = field(default_factory=list)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        self.payloads.append(payload)
        return self.result

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        return '{"phrases":[]}'


class FixedEmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [
            [0.0, 1.0] if "Sourdough" in text else [1.0, 0.0]
            for text in texts
        ]


class BlockingTier1Provider:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        self.started.set()
        await asyncio.to_thread(self.release.wait)
        return Tier1Result(verdict=Verdict.DRIFT, reason="unrelated")


class Tier1ProviderTest(unittest.TestCase):
    def test_parse_tier1_json_accepts_strict_ok_and_drift(self) -> None:
        ok = parse_tier1_json('{"verdict":"ok","reason":"normal subtopic"}')
        drift = parse_tier1_json('{"verdict":"drift","reason":"unrelated"}')

        self.assertEqual(ok.verdict, Verdict.OK)
        self.assertEqual(ok.reason, "normal subtopic")
        self.assertEqual(drift.verdict, Verdict.DRIFT)

    def test_parse_tier1_json_rejects_unknown_verdict(self) -> None:
        with self.assertRaises(ValueError):
            parse_tier1_json('{"verdict":"maybe","reason":"unclear"}')

    def test_factory_returns_none_when_api_config_missing(self) -> None:
        old_value = os.environ.pop("TIER1_API_KEY", None)
        try:
            provider = create_tier1_judge_provider(Tier1Config(enabled=True))
        finally:
            if old_value is not None:
                os.environ["TIER1_API_KEY"] = old_value

        self.assertIsNone(provider)

    def test_build_tier1_payload_contains_only_minimized_fields(self) -> None:
        observation = Observation(
            id="obs_test",
            ts="2026-07-04T00:00:00+00:00",
            session_id="sess_test",
            source=Source.BROWSER_NAV,
            payload={
                "url_host": "example.com",
                "url_path_hash": "x" * 64,
                "title": "Example",
                "tab_id": 3,
            },
        )
        goal = type("GoalLike", (), {"raw_text": "write API docs"})()
        payload = build_tier1_payload(
            goal=goal,
            observation=observation,
            recent=[ObservationSummary(title="Earlier", verdict="OK")],
            config=Tier1Config(),
        )

        as_json = json.dumps(payload)
        self.assertEqual(payload["goal"], "write API docs")
        self.assertEqual(payload["current"], {"title": "Example", "url_host": "example.com"})
        self.assertEqual(payload["recent"], [{"title": "Earlier", "verdict": "OK"}])
        self.assertNotIn("url_path_hash", as_json)
        self.assertNotIn("tab_id", as_json)
        self.assertNotIn("excerpt", as_json)

    def test_build_tier1_payload_includes_derived_phrases_when_available(self) -> None:
        observation = Observation(
            id="obs_test",
            ts="2026-07-04T00:00:00+00:00",
            session_id="sess_test",
            source=Source.BROWSER_NAV,
            payload={"title": "Create mod train tutorial", "url_host": "youtube.com"},
        )
        goal = type(
            "GoalLike",
            (),
            {
                "raw_text": "마인크래프트 크리에이트모드",
                "derived_phrases": ["Create mod train tutorial"],
            },
        )()

        payload = build_tier1_payload(goal, observation, [], Tier1Config())

        self.assertEqual(payload["goal"], "마인크래프트 크리에이트모드")
        self.assertEqual(payload["goal.derived_phrases"], ["Create mod train tutorial"])


class RaisingTier1Provider:
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        raise RuntimeError("boom")


class Tier1ResilienceAndFactoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_provider_error_keeps_tier0_verdict(self) -> None:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=True),
        )
        client = TestClient(create_app(config=config, store=store, tier1_provider=RaisingTier1Provider()))
        client.__enter__()
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            response = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {"url": "https://example.com/bread", "title": "Sourdough bread recipe"},
                },
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["verdict"], "DRIFT")
            observation = store.list_observations(session_id)[0]
            self.assertEqual(observation.verdict, "DRIFT")
            self.assertEqual(observation.tier_reached, 0)
            provider_status = client.get("/health").json()["provider_calls"]["tier1"]
            self.assertEqual(provider_status["last_result"], "error")
            self.assertEqual(provider_status["reason"], "other")
            with closing(sqlite3.connect(self.db_path)) as conn:
                count = conn.execute(
                    "SELECT COUNT(*) FROM event_log WHERE event_type = 'tier1.provider_error'"
                ).fetchone()[0]
            self.assertEqual(count, 1)
        finally:
            client.__exit__(None, None, None)

    def test_provider_success_is_reported_in_health(self) -> None:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=True),
        )
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.OK, reason="normal subtopic"))
        client = TestClient(create_app(config=config, store=store, tier1_provider=provider))
        client.__enter__()
        try:
            client.post("/sessions")
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {"url": "https://example.com/bread", "title": "Sourdough bread recipe"},
                },
            )

            provider_status = client.get("/health").json()["provider_calls"]["tier1"]
            self.assertEqual(provider_status["last_result"], "success")
            self.assertIsNone(provider_status["reason"])
        finally:
            client.__exit__(None, None, None)

    def test_factory_resolves_experiment_local_ollama(self) -> None:
        models_path = Path(self.tmpdir.name) / "models.yaml"
        models_path.write_text(
            'light:\n'
            '  api_url: "http://localhost:11434/api/chat"\n'
            '  ollama_model: "tiny:1b"\n'
            '  timeout_sec: 120\n'
        )
        old_value = os.environ.pop("TIER1_API_KEY", None)
        try:
            provider = create_tier1_judge_provider(
                Tier1Config(
                    enabled=True,
                    provider="experiment",
                    timeout_seconds=10,
                    experiment_models_file=str(models_path),
                    experiment_model_key="light",
                )
            )
        finally:
            if old_value is not None:
                os.environ["TIER1_API_KEY"] = old_value

        self.assertIsInstance(provider, OllamaChatJudgeProvider)
        assert isinstance(provider, OllamaChatJudgeProvider)
        self.assertEqual(provider.model, "tiny:1b")
        self.assertEqual(provider.api_key, "local-ollama")
        self.assertEqual(provider.timeout_seconds, 10)
        self.assertEqual(provider.max_output_tokens, 128)

    def test_activation_records_provider_degraded_event(self) -> None:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=True),
            tier2=Tier2Config(enabled=False),
        )
        old_value = os.environ.pop("TIER1_API_KEY", None)
        try:
            client = TestClient(create_app(config=config, store=store))
            client.__enter__()
            try:
                with closing(sqlite3.connect(self.db_path)) as conn:
                    startup_rows = conn.execute(
                        "SELECT payload_json FROM event_log WHERE event_type = 'provider.degraded'"
                    ).fetchall()
                self.assertEqual(startup_rows, [])

                client.post("/sessions")
                client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})

                with closing(sqlite3.connect(self.db_path)) as conn:
                    rows = conn.execute(
                        "SELECT payload_json FROM event_log WHERE event_type = 'provider.degraded'"
                    ).fetchall()
                self.assertEqual(len(rows), 1)
                payload = json.loads(rows[0][0])
                self.assertEqual(payload["tier"], 1)
                self.assertEqual(payload["reason"], "credentials_missing")
            finally:
                client.__exit__(None, None, None)
        finally:
            if old_value is not None:
                os.environ["TIER1_API_KEY"] = old_value


class Tier1ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _client(
        self,
        provider: FakeTier1Provider | None,
        controller: ControllerConfig | None = None,
    ) -> tuple[TestClient, SQLiteStore]:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=provider is not None),
            controller=controller or ControllerConfig(),
        )
        client = TestClient(create_app(config=config, store=store, tier1_provider=provider))
        client.__enter__()
        return client, store

    def test_tier1_can_reclassify_tier0_drift_as_ok(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.OK, reason="normal subtopic"))
        client, store = self._client(
            provider,
            ControllerConfig(
                type="alignment",
                alignment_alpha=0.0,
                coldstart_observations=1,
                cooldown_seconds=0,
            ),
        )
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/api",
                        "title": "Kibitzer observation API docs",
                    },
                },
            )

            response = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/design/palette?secret=1",
                        "title": "Product design palette",
                    },
                },
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["action"], "none")
        self.assertEqual(response.json()["verdict"], "OK")
        self.assertEqual(len(provider.payloads), 1)
        payload = provider.payloads[0]
        self.assertEqual(payload["current"], {"title": "Product design palette", "url_host": "example.com"})
        self.assertEqual(payload["recent"], [{"title": "Kibitzer observation API docs", "verdict": "OK"}])
        self.assertNotIn("secret", json.dumps(payload))
        self.assertNotIn("design/palette", json.dumps(payload))

        observations = store.list_observations(session_id)
        self.assertEqual(observations[-1].verdict, "OK")
        self.assertEqual(observations[-1].tier_reached, 1)
        self.assertEqual(observations[-1].tier1_reason, "normal subtopic")
        self.assertEqual(observations[-1].features["r_final"], 0.85)
        controller_state = store.get_controller_state(session_id)
        self.assertEqual(controller_state.alignment_score, 0.85)
        self.assertFalse(controller_state.drift_latched)
        with closing(sqlite3.connect(self.db_path)) as conn:
            event = conn.execute(
                "SELECT payload_json FROM event_log WHERE event_type = 'tier1.classified'"
            ).fetchone()[0]
        self.assertIn("normal subtopic", event)

    def test_tier1_can_confirm_drift(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.DRIFT, reason="unrelated entertainment"))
        client, store = self._client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            response = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/bread",
                        "title": "Sourdough bread recipe",
                    },
                },
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["verdict"], "DRIFT")
        self.assertEqual(len(provider.payloads), 1)
        observation = store.list_observations(session_id)[0]
        self.assertEqual(observation.verdict, "DRIFT")
        self.assertEqual(observation.tier_reached, 1)
        self.assertEqual(observation.features["r_final"], 0.0)

    def test_without_tier1_provider_tier0_drift_is_kept(self) -> None:
        client, store = self._client(None)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "Kibitzer observation API"})
            response = client.post(
                "/observations/browser-nav",
                json={
                    "source": "browser_nav",
                    "payload": {
                        "url": "https://example.com/bread",
                        "title": "Sourdough bread recipe",
                    },
                },
            )
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["verdict"], "DRIFT")
        observation = store.list_observations(session_id)[0]
        self.assertEqual(observation.tier_reached, 0)
        self.assertEqual(observation.features["r_final"], observation.features["r0"])

    def test_concurrent_browser_nav_keeps_request_order_across_slow_tier1(self) -> None:
        store = SQLiteStore(self.db_path)
        provider = BlockingTier1Provider()
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=True),
            controller=ControllerConfig(k=2, coldstart_observations=1),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
        )
        client = TestClient(
            create_app(
                config=config,
                store=store,
                embedding_provider=FixedEmbeddingProvider(),
                tier1_provider=provider,
            )
        )
        client.__enter__()
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post(
                "/sessions/current/goal",
                json={"raw_text": "Kibitzer observation API"},
            )
            older_drift = {
                "source": "browser_nav",
                "ts": "2026-07-15T00:00:00Z",
                "payload": {
                    "url": "https://example.com/bread",
                    "title": "Sourdough bread recipe",
                },
            }
            newer_ok = {
                "source": "browser_nav",
                "ts": "2026-07-15T00:00:01Z",
                "payload": {
                    "url": "https://example.com/api",
                    "title": "Kibitzer observation API docs",
                },
            }

            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    client.post,
                    "/observations/browser-nav",
                    json=older_drift,
                )
                self.assertTrue(provider.started.wait(timeout=2))
                second = executor.submit(
                    client.post,
                    "/observations/browser-nav",
                    json=newer_ok,
                )
                try:
                    with self.assertRaises(FutureTimeoutError):
                        second.result(timeout=0.2)
                finally:
                    provider.release.set()
                first_response = first.result(timeout=2)
                second_response = second.result(timeout=2)
        finally:
            provider.release.set()
            client.__exit__(None, None, None)

        self.assertEqual(first_response.json()["verdict"], Verdict.DRIFT.value)
        self.assertEqual(second_response.json()["verdict"], Verdict.OK.value)
        state = store.get_controller_state(session_id)
        self.assertEqual((state.obs_count, state.streak), (2, 0))
        with closing(sqlite3.connect(self.db_path)) as conn:
            attachment = conn.execute(
                "SELECT drift_started_at FROM attachment_states WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        self.assertIsNotNone(attachment)
        self.assertIsNone(attachment[0])


if __name__ == "__main__":
    unittest.main()

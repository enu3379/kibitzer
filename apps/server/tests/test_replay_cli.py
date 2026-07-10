import asyncio
import hashlib
import json
import sqlite3
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ControllerConfig, GoalEnrichmentConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.core.goal_enrichment import DerivedPhrase
from apps.server.app.main import create_app
from apps.server.app.providers.embeddings.hash_cpu import HashCpuEmbeddingProvider
from apps.server.app.providers.judges.base import Tier1Result
from apps.server.app.replay import apply_config_overrides, replay_session
from apps.server.app.replay.core import _read_goal_fallback
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import SQLiteStore


@dataclass
class FakeTier1Provider:
    result: Tier1Result
    payloads: list[dict[str, object]] = field(default_factory=list)

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        self.payloads.append(payload)
        return self.result

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        return '{"phrases":[]}'


class ReplayCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _config(self, *, tier1_enabled: bool = False) -> AppConfig:
        return AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
            tier1=Tier1Config(enabled=tier1_enabled),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
        )

    def _client(
        self,
        config: AppConfig,
        tier1_provider: FakeTier1Provider | None = None,
    ) -> tuple[TestClient, SQLiteStore]:
        store = SQLiteStore(self.db_path)
        client = TestClient(create_app(config=config, store=store, tier1_provider=tier1_provider))
        client.__enter__()
        return client, store

    def _start_goal(self, client: TestClient, raw_text: str = "Kibitzer observation API") -> str:
        session_id = client.post("/sessions").json()["id"]
        response = client.post("/sessions/current/goal", json={"raw_text": raw_text})
        self.assertEqual(response.status_code, 200)
        return session_id

    def _visit(self, client: TestClient, title: str) -> dict[str, object]:
        response = client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": f"https://example.com/{title.lower().replace(' ', '-')}",
                    "title": title,
                    "tab_id": 1,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.json()

    def _related_feedback_fixture(self) -> tuple[AppConfig, str]:
        config = self._config(tier1_enabled=False)
        client, _store = self._client(config)
        try:
            session_id = self._start_goal(client)
            first = self._visit(client, "Sourdough bread recipe")
            self.assertEqual(first["action"], "request_excerpt")
            notification = client.post(
                f"/observations/{first['observation_id']}/excerpt",
                json={"title": "Sourdough bread recipe", "text": "unrelated baking notes"},
            ).json()
            self.assertEqual(notification["action"], "notify")
            feedback = client.post(
                "/feedback",
                json={
                    "kind": "related",
                    "intervention_id": notification["intervention_id"],
                    "observation_id": first["observation_id"],
                },
            ).json()
            self.assertEqual(feedback["kind"], "related")
            second = self._visit(client, "Sourdough bread recipe")
            self.assertEqual(second["verdict"], "OK")
        finally:
            client.__exit__(None, None, None)
        return config, session_id

    def test_round_trip_replays_api_session_with_related_feedback(self) -> None:
        config, session_id = self._related_feedback_fixture()

        result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))

        changed = [row for row in result.rows if row.changed]
        self.assertEqual(changed, [])
        for row in result.rows:
            self.assertIsNotNone(row.r0_orig)
            self.assertAlmostEqual(row.r0_orig, row.r0_replay, places=9)
            self.assertEqual(row.verdict_orig, row.verdict_replay)
            self.assertEqual(row.tier_orig, row.tier_replay)

    def test_threshold_override_flips_expected_rows_only(self) -> None:
        config = self._config(tier1_enabled=False)
        client, _store = self._client(config)
        try:
            session_id = self._start_goal(client)
            self._visit(client, "Kibitzer observation API docs")
            self._visit(client, "Sourdough bread recipe")
        finally:
            client.__exit__(None, None, None)

        strict_config, overrides = apply_config_overrides(config, ["relevance.tau_ok=1.1"])
        result = asyncio.run(
            replay_session(self.db_path, session=session_id, config=strict_config, overrides=overrides)
        )

        flipped_titles = [row.title for row in result.rows if "flip" in row.flags]
        self.assertEqual(flipped_titles, ["Kibitzer observation API docs"])
        self.assertEqual(result.summary["flips"], {"OK->DRIFT": 1, "DRIFT->OK": 0})

    def test_exemplar_event_changes_only_subsequent_scores(self) -> None:
        config, session_id = self._related_feedback_fixture()

        result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))

        self.assertEqual([row.title for row in result.rows], ["Sourdough bread recipe", "Sourdough bread recipe"])
        self.assertLess(result.rows[0].r0_replay, config.relevance.tau_ok)
        self.assertAlmostEqual(result.rows[1].r0_replay, 1.0, places=9)

    def test_page_label_drift_removes_exemplar_from_replay_timeline(self) -> None:
        config = self._config(tier1_enabled=False)
        client, _store = self._client(config)
        try:
            session_id = self._start_goal(client)
            first = self._visit(client, "Sourdough bread recipe")
            observation_id = str(first["observation_id"])
            client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            client.post(
                f"/observations/{observation_id}/label",
                json={"label": "drift"},
            )
            second = self._visit(client, "Sourdough bread recipe")
            client.post(
                f"/observations/{observation_id}/label",
                json={"label": "related"},
            )
            third = self._visit(client, "Sourdough bread recipe")
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first["verdict"], "DRIFT")
        self.assertEqual(second["verdict"], "DRIFT")
        self.assertEqual(third["verdict"], "OK")

        result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))

        self.assertEqual([row.verdict_replay for row in result.rows], ["DRIFT", "DRIFT", "OK"])
        self.assertEqual([row for row in result.rows if row.changed], [])

    def test_zero_anchor_window_uses_no_replay_anchor(self) -> None:
        config = self._config(tier1_enabled=False)
        client, store = self._client(config)
        try:
            session_id = self._start_goal(client)
            self._visit(client, "Kibitzer observation API docs")
            self._visit(client, "Kibitzer observation API docs")
        finally:
            client.__exit__(None, None, None)

        zero_anchor_config, overrides = apply_config_overrides(config, ["relevance.anchor_window=0"])
        self.assertIsNone(store.anchor_value(session_id, 0))
        result = asyncio.run(
            replay_session(
                self.db_path,
                session=session_id,
                config=zero_anchor_config,
                overrides=overrides,
            )
        )

        self.assertEqual([row.anchor_score_replay for row in result.rows], [0.0, 0.0])
        with self.assertRaises(ValueError):
            apply_config_overrides(config, ["relevance.anchor_window=-1"])

    def test_null_goal_fallback_stays_none(self) -> None:
        with sqlite3.connect(":memory:") as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE goals (session_id TEXT PRIMARY KEY, raw_text TEXT)")
            conn.execute("INSERT INTO goals (session_id, raw_text) VALUES ('sess_null', NULL)")

            fallback = _read_goal_fallback(conn, "sess_null")

        self.assertIsNone(fallback)

    def test_tier1_recording_and_no_recording_are_replayed(self) -> None:
        config = self._config(tier1_enabled=True)
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.DRIFT, reason="recorded drift"))
        client, _store = self._client(config, provider)
        try:
            session_id = self._start_goal(client)
            self._visit(client, "Sourdough bread recipe")
            self._visit(client, "Kibitzer observation API docs")
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(len(provider.payloads), 1)
        default_result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))
        recorded_row = default_result.rows[0]
        self.assertEqual(recorded_row.tier_replay, 1)
        self.assertEqual(recorded_row.verdict_replay, "DRIFT")
        self.assertEqual(recorded_row.tier1_reason, "recorded drift")
        self.assertFalse(recorded_row.tier1_no_recording)

        strict_config, overrides = apply_config_overrides(config, ["relevance.tau_ok=1.1"])
        strict_result = asyncio.run(
            replay_session(self.db_path, session=session_id, config=strict_config, overrides=overrides)
        )
        no_recording_rows = [row for row in strict_result.rows if row.tier1_no_recording]
        self.assertEqual([row.title for row in no_recording_rows], ["Kibitzer observation API docs"])
        self.assertEqual(strict_result.summary["tier1"]["no_recording"], 1)

    def test_goal_enriched_event_is_replayed(self) -> None:
        config = self._config(tier1_enabled=False)
        client, store = self._client(config)
        try:
            session_id = self._start_goal(client)
            vector = asyncio.run(HashCpuEmbeddingProvider().embed(["Sourdough bread recipe"]))[0]
            store.replace_goal_derived_exemplars(
                session_id,
                [DerivedPhrase(phrase="Sourdough bread recipe", vector=vector)],
                provider="test",
                latency_ms=1,
            )
            self._visit(client, "Sourdough bread recipe")
        finally:
            client.__exit__(None, None, None)

        result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))

        self.assertEqual(result.rows[0].verdict_replay, "OK")
        self.assertAlmostEqual(result.rows[0].derived_score_replay, 1.0, places=9)
        self.assertTrue(result.rows[0].anchor_eligible_replay)

    def test_derived_phrases_file_injects_after_goal_declaration(self) -> None:
        config = self._config(tier1_enabled=False)
        client, _store = self._client(config)
        try:
            session_id = self._start_goal(client)
            self._visit(client, "Sourdough bread recipe")
        finally:
            client.__exit__(None, None, None)

        phrases_path = Path(self.tmpdir.name) / "phrases.json"
        phrases_path.write_text(
            json.dumps({"goals": {session_id[:13]: {"phrases": ["Sourdough bread recipe"]}}}),
            encoding="utf-8",
        )
        result = asyncio.run(
            replay_session(
                self.db_path,
                session=session_id,
                config=config,
                derived_phrases_path=phrases_path,
            )
        )

        self.assertEqual(result.rows[0].verdict_replay, "OK")
        self.assertIn("flip", result.rows[0].flags)
        self.assertAlmostEqual(result.rows[0].derived_score_replay, 1.0, places=9)

    def test_replay_does_not_modify_source_db(self) -> None:
        config, session_id = self._related_feedback_fixture()
        before = hashlib.sha256(self.db_path.read_bytes()).hexdigest()

        asyncio.run(replay_session(self.db_path, session=session_id, config=config))

        after = hashlib.sha256(self.db_path.read_bytes()).hexdigest()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()

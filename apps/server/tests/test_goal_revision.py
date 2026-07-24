import asyncio
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    GoalEnrichmentConfig,
    ServerConfig,
    Tier1Config,
)
from apps.server.app.core.goal_enrichment import DerivedPhrase
from apps.server.app.core.ingest import ingest_browser_nav
from apps.server.app.core.runtime_resources import RuntimeResources
from apps.server.app.main import create_app
from apps.server.app.privacy.domain_filter import SensitiveDomainRules
from apps.server.app.schemas import (
    Observation,
    ObservationFeatures,
    PipelineAction,
    RawObservation,
    Source,
    Verdict,
)
from apps.server.app.storage.sqlite import SQLiteStore


class GoalRevisionStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        self.store.initialize()
        self.session = self.store.create_session()

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _observation(self, observation_id: str, verdict: Verdict, embedding: list[float]) -> Observation:
        return Observation(
            id=observation_id,
            ts=datetime.now(timezone.utc),
            session_id=self.session.id,
            source=Source.BROWSER_NAV,
            payload={
                "url_host": "example.com",
                "url_path_hash": f"hash-{observation_id}",
                "title": observation_id,
                "tab_id": 1,
            },
            features=ObservationFeatures(
                emb=embedding,
                r0=1.0 if verdict == Verdict.OK else 0.0,
                r_final=1.0 if verdict == Verdict.OK else 0.0,
                tier_reached=0,
            ),
            verdict=verdict,
        )

    def test_goal_edit_versions_history_and_resets_live_goal_state(self) -> None:
        first_goal = self.store.set_current_goal("goal one", exemplar=[1.0, 0.0])
        ok = self._observation("obs_ok", Verdict.OK, [1.0, 0.0])
        drift = self._observation("obs_drift", Verdict.DRIFT, [0.0, 1.0])
        self.store.record_observation(ok, goal_revision=first_goal.goal_revision)
        self.store.record_observation(drift, goal_revision=first_goal.goal_revision)
        self.store.save_controller_state(
            self.session.id,
            streak=2,
            obs_count=2,
            last_intervention_ts=datetime.now(timezone.utc),
            snoozed_until=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        self.store.note_attachment_observation(
            self.session.id,
            Verdict.DRIFT.value,
            datetime.now(timezone.utc),
            drift_confirmed=True,
        )
        self.store.record_drift_presence(
            self.session.id,
            drift.id,
            "presence-old-goal",
            "active",
            tab_id=1,
            url_path_hash="hash-obs_drift",
            max_gap_seconds=90,
        )
        candidate, _created = self.store.create_intervention_candidate(
            self.session.id,
            drift.id,
            datetime.now(timezone.utc) + timedelta(minutes=1),
            goal_revision=first_goal.goal_revision,
        )
        self.store.replace_goal_derived_exemplars(
            self.session.id,
            [DerivedPhrase(phrase="derived one", vector=[1.0, 0.0])],
            goal_revision=first_goal.goal_revision,
            provider="test",
            latency_ms=1,
        )
        self.assertEqual(self.store.anchor_value(self.session.id, 10), [1.0, 0.0])

        second_goal = self.store.set_current_goal("goal two", exemplar=[0.0, 1.0])

        self.assertEqual((first_goal.goal_revision, second_goal.goal_revision), (1, 2))
        self.assertEqual(
            [item.goal_revision for item in self.store.list_observations(self.session.id)],
            [1, 1],
        )
        controller = self.store.get_controller_state(self.session.id)
        self.assertEqual((controller.streak, controller.obs_count), (0, 0))
        self.assertIsNone(controller.last_intervention_ts)
        self.assertIsNone(controller.snoozed_until)
        clock = self.store.get_drift_clock_state(self.session.id)
        self.assertIsNone(clock.active_observation_id)
        self.assertEqual(clock.current_page_drift_seconds, 0)
        self.assertEqual(clock.cumulative_drift_seconds, 0)
        self.assertIsNone(self.store.anchor_value(self.session.id, 10))
        self.assertEqual(self.store.recent_observation_summaries(self.session.id, 10), [])
        self.assertEqual(self.store.get_current_session().goal.derived_exemplars, [])
        self.assertEqual(
            self.store.get_intervention_candidate_for_observation(drift.id).status,
            "cancelled",
        )
        self.assertEqual(candidate.goal_revision, first_goal.goal_revision)
        with closing(sqlite3.connect(self.db_path)) as conn:
            attachment_count = conn.execute(
                "SELECT COUNT(*) FROM attachment_states WHERE session_id = ?",
                (self.session.id,),
            ).fetchone()[0]
        self.assertEqual(attachment_count, 0)

        _label, exemplar_count, _added = self.store.record_page_label(
            self.session.id,
            ok.id,
            "related",
            exemplar_cap=20,
        )
        self.assertIsNone(exemplar_count)
        self.assertEqual(self.store.get_goal_exemplars(self.session.id), [[0.0, 1.0]])
        self.assertIsNone(self.store.anchor_value(self.session.id, 10))


class FixedGoalEmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = []
        for text in texts:
            if text == "goal beta":
                vectors.append([0.0, 1.0])
            else:
                vectors.append([1.0, 0.0])
        return vectors


class GoalRevisionApiTest(unittest.TestCase):
    def test_old_goal_ok_page_does_not_become_the_new_goal_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            config = AppConfig(
                server=ServerConfig(db_path=str(db_path)),
                tier1=Tier1Config(enabled=False),
                goal_enrichment=GoalEnrichmentConfig(enabled=False),
            )
            with TestClient(
                create_app(
                    config=config,
                    store=store,
                    embedding_provider=FixedGoalEmbeddingProvider(),
                )
            ) as client:
                session_id = client.post("/sessions").json()["id"]
                client.post(
                    "/sessions/current/goal",
                    json={"raw_text": "goal alpha"},
                ).json()
                first = client.post(
                    "/observations/browser-nav",
                    json={
                        "source": "browser_nav",
                        "payload": {"url": "https://example.com/old", "title": "Old goal page"},
                    },
                ).json()
                client.post(
                    "/sessions/current/goal",
                    json={"raw_text": "goal beta"},
                ).json()
                second = client.post(
                    "/observations/browser-nav",
                    json={
                        "source": "browser_nav",
                        "payload": {"url": "https://example.com/old", "title": "Old goal page"},
                    },
                ).json()

            self.assertEqual(first["verdict"], Verdict.OK.value)
            self.assertEqual(second["verdict"], Verdict.DRIFT.value)
            self.assertEqual(
                [item.goal_revision for item in store.list_observations(session_id)],
                [1, 2],
            )
            self.assertIsNone(store.anchor_value(session_id, 10))


class BlockingEmbeddingProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.started.set()
        await self.release.wait()
        return [[1.0, 0.0] for _text in texts]


class GoalRevisionConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_ingest_keeps_captured_revision_but_cannot_mutate_new_live_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            store.initialize()
            session = store.create_session()
            first_goal = store.set_current_goal("goal one", exemplar=[0.0, 1.0])
            config = AppConfig(
                server=ServerConfig(db_path=str(db_path)),
                tier1=Tier1Config(enabled=False),
                controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
                goal_enrichment=GoalEnrichmentConfig(enabled=False),
            )
            embedding = BlockingEmbeddingProvider()
            runtime = RuntimeResources(config, store, embedding_provider=embedding)
            task = asyncio.create_task(
                ingest_browser_nav(
                    RawObservation.model_validate(
                        {
                            "source": "browser_nav",
                            "payload": {
                                "url": "https://example.com/stale",
                                "title": "Stale in-flight page",
                            },
                        }
                    ),
                    store.get_current_session(),
                    config=config,
                    store=store,
                    runtime=runtime,
                    sensitive_domain_rules=SensitiveDomainRules([], []),
                    persona_set=None,
                )
            )
            await embedding.started.wait()
            second_goal = store.set_current_goal("goal two", exemplar=[1.0, 0.0])
            embedding.release.set()

            result = await task

            self.assertEqual(result.action, PipelineAction.NONE)
            self.assertEqual((first_goal.goal_revision, second_goal.goal_revision), (1, 2))
            observations = store.list_observations(session.id)
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0].goal_revision, first_goal.goal_revision)
            self.assertEqual(observations[0].verdict, Verdict.DRIFT.value)
            controller = store.get_controller_state(session.id)
            self.assertEqual((controller.streak, controller.obs_count), (0, 0))
            self.assertIsNone(
                store.get_intervention_candidate_for_observation(observations[0].id)
            )
            with closing(sqlite3.connect(db_path)) as conn:
                attachment_count = conn.execute(
                    "SELECT COUNT(*) FROM attachment_states WHERE session_id = ?",
                    (session.id,),
                ).fetchone()[0]
            self.assertEqual(attachment_count, 0)


if __name__ == "__main__":
    unittest.main()

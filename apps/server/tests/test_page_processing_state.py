import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from apps.server.tests.support import TestClient

from apps.server.app.config import AppConfig, ServerConfig, Tier1Config, Tier2Config
from apps.server.app.core.ingest import ingest_browser_nav
from apps.server.app.core.normalization import normalize_browser_nav
from apps.server.app.core.runtime_resources import RuntimeResources
from apps.server.app.main import create_app
from apps.server.app.privacy.domain_filter import SensitiveDomainRules
from apps.server.app.providers.judges.base import Tier1Result
from apps.server.app.schemas import RawObservation, Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class BlockingEmbeddingProvider:
    def __init__(self, vector: list[float]) -> None:
        self.vector = vector
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.started.set()
        await self.release.wait()
        return [self.vector for _text in texts]


class ImmediateEmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0, 1.0] for _text in texts]


class BlockingTier1Provider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        self.started.set()
        await self.release.wait()
        return Tier1Result(verdict=Verdict.DRIFT, reason="unrelated")


class PageProcessingStateApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            tier1=Tier1Config(enabled=False),
            tier2=Tier2Config(enabled=False),
        )
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()
        self.session_id = self.client.post("/sessions").json()["id"]
        self.client.post("/sessions/current/goal", json={"raw_text": "Read Kibitzer API docs"})

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _identity(self, url: str, tab_id: int = 7) -> dict[str, str | int]:
        parsed = urlparse(url)
        location = parsed.path or "/"
        if parsed.query:
            location += f"?{parsed.query}"
        if parsed.fragment:
            location += f"#{parsed.fragment}"
        return {
            "tab_id": tab_id,
            "url_host": parsed.hostname or "",
            "url_path_hash": hashlib.sha256(location.encode()).hexdigest(),
        }

    def _raw(self, url: str, tab_id: int = 7) -> RawObservation:
        return RawObservation.model_validate(
            {
                "source": "browser_nav",
                "payload": {"url": url, "title": "Kibitzer API", "tab_id": tab_id},
            }
        )

    def _seed_processing_state(self, url: str = "https://example.com/kibitzer-api") -> str:
        current = self.store.get_current_session()
        assert current and current.goal
        observation = normalize_browser_nav(self._raw(url), self.session_id)
        self.store.set_observation_processing_stage(
            observation,
            current.goal.goal_revision,
            "tier0",
        )
        return current.session.id

    def _processing_state_count(self, session_id: str) -> int:
        with self.store._connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM observation_processing_states WHERE session_id = ?",
                (session_id,),
            ).fetchone()[0]

    def test_page_state_reports_tier0_and_tier1_processing(self) -> None:
        url = "https://example.com/kibitzer-api"
        current = self.store.get_current_session()
        assert current and current.goal
        observation = normalize_browser_nav(self._raw(url), self.session_id)

        self.store.set_observation_processing_stage(observation, current.goal.goal_revision, "tier0")
        tier0 = self.client.get("/observations/page-state", params=self._identity(url))
        self.store.set_observation_processing_stage(observation, current.goal.goal_revision, "tier1")
        tier1 = self.client.get("/observations/page-state", params=self._identity(url))
        stale_url = self.client.get(
            "/observations/page-state",
            params=self._identity("https://example.com/other"),
        )

        self.assertEqual(tier0.status_code, 200)
        self.assertEqual(tier0.json()["state"], "processing")
        self.assertEqual(tier0.json()["stage"], "tier0")
        self.assertEqual(tier1.json()["stage"], "tier1")
        self.assertEqual(stale_url.json(), {
            "state": "unobserved",
            "stage": None,
            "observation_id": None,
            "title": None,
            "url_host": None,
            "observation": None,
        })

    def test_page_state_returns_judged_observation_after_processing_clears(self) -> None:
        url = "https://example.com/kibitzer-api"
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {"url": url, "title": "Kibitzer API", "tab_id": 7},
            },
        )
        state = self.client.get("/observations/page-state", params=self._identity(url))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(state.json()["state"], "judged")
        self.assertEqual(state.json()["observation"]["observation_id"], response.json()["observation_id"])
        with self.store._connect() as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM observation_processing_states").fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_replacing_session_clears_processing_state(self) -> None:
        session_id = self._seed_processing_state()

        replacement = self.store.create_session()

        self.assertNotEqual(replacement.id, session_id)
        self.assertEqual(self._processing_state_count(session_id), 0)

    def test_ending_session_clears_processing_state(self) -> None:
        session_id = self._seed_processing_state()

        ended = self.store.end_current_session()

        self.assertEqual(ended.id, session_id)
        self.assertEqual(self._processing_state_count(session_id), 0)


class PageProcessingStateTransitionTest(unittest.IsolatedAsyncioTestCase):
    def _raw(self) -> RawObservation:
        return RawObservation.model_validate(
            {
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/current-page",
                    "title": "Current page",
                    "tab_id": 7,
                },
            }
        )

    def _config(self, db_path: Path, *, tier1_enabled: bool) -> AppConfig:
        return AppConfig(
            server=ServerConfig(db_path=str(db_path)),
            tier1=Tier1Config(enabled=tier1_enabled),
            tier2=Tier2Config(enabled=False),
        )

    def _processing_state(self, store: SQLiteStore, session_id: str, goal_revision: int):
        observation = normalize_browser_nav(self._raw(), session_id)
        return store.observation_processing_state_for_page(
            session_id,
            goal_revision,
            7,
            str(observation.payload["url_host"]),
            str(observation.payload["url_path_hash"]),
        )

    async def test_ingest_exposes_tier0_until_embedding_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            store.initialize()
            session = store.create_session()
            goal = store.set_current_goal("Current goal", exemplar=[1.0, 0.0])
            config = self._config(db_path, tier1_enabled=False)
            embedding = BlockingEmbeddingProvider([1.0, 0.0])
            runtime = RuntimeResources(config, store, embedding_provider=embedding)

            task = asyncio.create_task(
                ingest_browser_nav(
                    self._raw(),
                    store.get_current_session(),
                    config=config,
                    store=store,
                    runtime=runtime,
                    sensitive_domain_rules=SensitiveDomainRules([], []),
                    persona_set=None,
                )
            )
            await embedding.started.wait()

            processing = self._processing_state(store, session.id, goal.goal_revision)
            self.assertIsNotNone(processing)
            assert processing is not None
            self.assertEqual(processing.stage, "tier0")

            embedding.release.set()
            await task
            self.assertIsNone(self._processing_state(store, session.id, goal.goal_revision))

    async def test_ingest_switches_to_tier1_until_provider_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            store.initialize()
            session = store.create_session()
            goal = store.set_current_goal("Current goal", exemplar=[1.0, 0.0])
            config = self._config(db_path, tier1_enabled=True)
            tier1 = BlockingTier1Provider()
            runtime = RuntimeResources(
                config,
                store,
                embedding_provider=ImmediateEmbeddingProvider(),
                tier1_provider=tier1,
            )

            task = asyncio.create_task(
                ingest_browser_nav(
                    self._raw(),
                    store.get_current_session(),
                    config=config,
                    store=store,
                    runtime=runtime,
                    sensitive_domain_rules=SensitiveDomainRules([], []),
                    persona_set=None,
                )
            )
            await tier1.started.wait()

            processing = self._processing_state(store, session.id, goal.goal_revision)
            self.assertIsNotNone(processing)
            assert processing is not None
            self.assertEqual(processing.stage, "tier1")

            tier1.release.set()
            await task
            self.assertIsNone(self._processing_state(store, session.id, goal.goal_revision))
            self.assertEqual(store.list_observations(session.id)[0].tier_reached, 1)


if __name__ == "__main__":
    unittest.main()

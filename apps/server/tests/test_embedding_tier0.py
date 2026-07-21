import json
import math
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import AppConfig, ServerConfig
from apps.server.app.core.relevance import (
    Tier0Score,
    anchor_admission_eligible,
    cosine,
    tier0_score,
    tier0_score_parts,
)
from apps.server.app.main import create_app
from apps.server.app.providers.embeddings.hash_cpu import HashCpuEmbeddingProvider
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class EmbeddingTier0Test(unittest.IsolatedAsyncioTestCase):
    async def test_hash_cpu_embedding_is_deterministic_and_normalized(self) -> None:
        provider = HashCpuEmbeddingProvider(dimensions=32, normalize=True)

        first = (await provider.embed(["Kibitzer observation API"]))[0]
        second = (await provider.embed(["Kibitzer observation API"]))[0]
        unrelated = (await provider.embed(["sourdough bread recipe"]))[0]

        self.assertEqual(first, second)
        self.assertAlmostEqual(math.sqrt(sum(value * value for value in first)), 1.0)
        self.assertLess(cosine(first, unrelated), 0.55)

    async def test_korean_spacing_variants_overlap_via_bigrams(self) -> None:
        provider = HashCpuEmbeddingProvider(dimensions=256, normalize=True)
        goal, spaced_related, unrelated = await provider.embed(
            [
                "마인크래프트 크리에이트모드",
                "크리에이트 모드 풍차 도움 - 스티브(마인크래프트) 마이너 갤러리\ngall.dcinside.com",
                "오늘의 뉴스 헤드라인 - 연합뉴스\nwww.yna.co.kr",
            ]
        )

        self.assertGreaterEqual(tier0_score(spaced_related, [goal], None, beta=0.85), 0.15)
        self.assertLess(tier0_score(unrelated, [goal], None, beta=0.85), 0.15)

    async def test_tier0_score_prefers_exemplar_then_anchor(self) -> None:
        provider = HashCpuEmbeddingProvider(dimensions=64, normalize=True)
        goal, related, anchor_related, unrelated = await provider.embed(
            [
                "Kibitzer observation API",
                "Kibitzer observation API docs",
                "Kibitzer observation API reference",
                "sourdough bread recipe",
            ]
        )

        self.assertGreaterEqual(tier0_score(related, [goal], None, beta=0.85), 0.55)
        self.assertGreaterEqual(tier0_score(anchor_related, [], related, beta=0.85), 0.55)
        self.assertLess(tier0_score(unrelated, [goal], related, beta=0.85), 0.55)

    async def test_derived_score_uses_separate_threshold_gate(self) -> None:
        emb = [1.0, 0.0, 0.0]
        below = [0.2, math.sqrt(1 - 0.2**2), 0.0]
        above = [0.3, math.sqrt(1 - 0.3**2), 0.0]

        below_score = tier0_score_parts(
            emb,
            exemplars=[],
            anchor=None,
            beta=0.85,
            derived_exemplars=[below],
            derived_tau=0.25,
        )
        above_score = tier0_score_parts(
            emb,
            exemplars=[],
            anchor=None,
            beta=0.85,
            derived_exemplars=[above],
            derived_tau=0.25,
        )

        self.assertAlmostEqual(below_score.derived_score, 0.2)
        self.assertEqual(below_score.score, 0.0)
        self.assertAlmostEqual(above_score.derived_score, 0.3)
        self.assertAlmostEqual(above_score.score, 0.3)


class AnchorTiebreakFloorTest(unittest.TestCase):
    """The anchor may only lift pages with direct goal affinity (pollution-loop fix)."""

    def _exemplar_at(self, target_cosine: float) -> list[float]:
        return [target_cosine, math.sqrt(1 - target_cosine**2), 0.0]

    def test_anchor_cannot_solo_ok_below_floor(self) -> None:
        emb = [1.0, 0.0, 0.0]
        anchor = [1.0, 0.0, 0.0]  # polluted anchor, perfectly aligned with the page

        score = tier0_score_parts(
            emb,
            exemplars=[self._exemplar_at(0.2)],
            anchor=anchor,
            beta=0.85,
            anchor_tiebreak_floor=0.30,
        )

        self.assertAlmostEqual(score.anchor_score, 0.85)  # raw diagnostic preserved
        self.assertAlmostEqual(score.score, 0.2)  # anchor excluded from the verdict score

    def test_anchor_lifts_page_at_or_above_floor(self) -> None:
        emb = [1.0, 0.0, 0.0]
        anchor = [1.0, 0.0, 0.0]

        score = tier0_score_parts(
            emb,
            exemplars=[self._exemplar_at(0.35)],
            anchor=anchor,
            beta=0.85,
            anchor_tiebreak_floor=0.30,
        )

        self.assertAlmostEqual(score.score, 0.85)

    def test_derived_affinity_also_unlocks_anchor(self) -> None:
        emb = [1.0, 0.0, 0.0]
        anchor = [1.0, 0.0, 0.0]

        score = tier0_score_parts(
            emb,
            exemplars=[],
            anchor=anchor,
            beta=0.85,
            derived_exemplars=[self._exemplar_at(0.4)],
            derived_tau=0.25,
            anchor_tiebreak_floor=0.30,
        )

        self.assertAlmostEqual(score.score, 0.85)

    def test_zero_floor_keeps_legacy_solo_anchor_ok(self) -> None:
        emb = [1.0, 0.0, 0.0]
        anchor = [1.0, 0.0, 0.0]

        score = tier0_score_parts(
            emb,
            exemplars=[self._exemplar_at(0.2)],
            anchor=anchor,
            beta=0.85,
            anchor_tiebreak_floor=0.0,
        )

        self.assertAlmostEqual(score.score, 0.85)

    def test_tier1_ok_needs_affinity_to_join_anchor(self) -> None:
        low_affinity = Tier0Score(score=0.0, exemplar_score=0.02, anchor_score=0.9)

        legacy = anchor_admission_eligible(
            low_affinity,
            has_derived_exemplars=False,
            anchor_epsilon=0.05,
            derived_tau=0.25,
            verdict=Verdict.OK,
            tier_reached=1,
            tier1_anchor_floor=0.0,
        )
        guarded = anchor_admission_eligible(
            low_affinity,
            has_derived_exemplars=False,
            anchor_epsilon=0.05,
            derived_tau=0.25,
            verdict=Verdict.OK,
            tier_reached=1,
            tier1_anchor_floor=0.30,
        )

        self.assertTrue(legacy)  # the old unconditional Tier 1 bypass
        self.assertFalse(guarded)  # a lone Tier 1 OK can no longer seed the anchor

    def test_tier1_floor_is_not_voided_by_epsilon_branch(self) -> None:
        # Affinity above epsilon (0.05) but below the Tier 1 floor (0.30) — the
        # exact profile of the webtoon-binge seed. The epsilon branch must not
        # admit what the Tier 1 gate rejects.
        binge_seed = Tier0Score(score=0.0, exemplar_score=0.235, anchor_score=0.7)

        guarded = anchor_admission_eligible(
            binge_seed,
            has_derived_exemplars=False,
            anchor_epsilon=0.05,
            derived_tau=0.25,
            verdict=Verdict.OK,
            tier_reached=1,
            tier1_anchor_floor=0.30,
        )
        tier0_same_affinity = anchor_admission_eligible(
            binge_seed,
            has_derived_exemplars=False,
            anchor_epsilon=0.05,
            derived_tau=0.25,
            verdict=Verdict.OK,
            tier_reached=0,
            tier1_anchor_floor=0.30,
        )

        self.assertFalse(guarded)  # Tier 1 OK: floor applies despite epsilon
        self.assertTrue(tier0_same_affinity)  # Tier 0 OK: epsilon branch unchanged


class Tier0ApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(server=ServerConfig(db_path=str(self.db_path)))
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_related_observation_gets_tier0_ok(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]
        self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API"},
        )

        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/kibitzer-api",
                    "title": "Kibitzer observation API docs",
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "OK")
        observation = self.store.list_observations(session_id)[0]
        self.assertEqual(observation.verdict, "OK")
        self.assertEqual(observation.tier_reached, 0)
        self.assertGreaterEqual(observation.features["r0"], 0.55)
        self.assertIsInstance(observation.features["emb"], list)

    def test_unrelated_observation_gets_tier0_drift_and_does_not_update_anchor(self) -> None:
        session_id = self.client.post("/sessions").json()["id"]
        self.client.post(
            "/sessions/current/goal",
            json={"raw_text": "Kibitzer observation API"},
        )

        drift_response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/bread",
                    "title": "Sourdough bread recipe",
                },
            },
        )
        ok_response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {
                    "url": "https://example.com/api",
                    "title": "Kibitzer observation API docs",
                },
            },
        )

        self.assertEqual(drift_response.json()["verdict"], "DRIFT")
        self.assertEqual(ok_response.json()["verdict"], "OK")

        observations = self.store.list_observations(session_id)
        self.assertEqual([obs.verdict for obs in observations], ["DRIFT", "OK"])
        self.assertEqual(len(self.store.recent_ok_embeddings(session_id, limit=10)), 1)

        with closing(sqlite3.connect(self.db_path)) as conn:
            drift_features = json.loads(
                conn.execute(
                    "SELECT features_json FROM observations WHERE verdict = 'DRIFT'",
                ).fetchone()[0]
            )
        self.assertLess(drift_features["r0"], 0.55)


if __name__ == "__main__":
    unittest.main()

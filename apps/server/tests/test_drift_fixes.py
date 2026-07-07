"""Regression tests for the 2026-07-08 drift-detection fixes.

Source incident (docs/planning-notes.md "Evidence"): with goal "LG그램 수리",
"킬로그램 - 나무위키" entered the OK anchor via the shared "그램" bigram and its
"- 나무위키" title furniture then whitelisted the whole platform — Giggle /
미니언즈 / 현덕왕후 / 호날두 all rode `beta * cos(anchor)` past tau_ok.

Two independent mechanisms under test:
1. Title-furniture stripping — per-host repeated trailing segments are removed
   before embedding.
2. Anchor admission guard — anchor-only OKs keep their verdict but are excluded
   from the anchor.
"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from apps.server.app.config import AppConfig, ServerConfig
from apps.server.app.core.normalization import strip_repeated_title_suffix
from apps.server.app.main import create_app
from apps.server.app.schemas import Observation, ObservationFeatures, Source, Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class TitleFurnitureStripTest(unittest.TestCase):
    def test_strips_suffix_repeated_on_host(self) -> None:
        previous = ["킬로그램 - 나무위키", "Growth Of Giggle - 나무위키"]
        self.assertEqual(
            strip_repeated_title_suffix("현덕왕후 - 나무위키", previous),
            "현덕왕후",
        )

    def test_keeps_suffix_without_enough_repeats(self) -> None:
        self.assertEqual(
            strip_repeated_title_suffix("킬로그램 - 나무위키", []),
            "킬로그램 - 나무위키",
        )
        self.assertEqual(
            strip_repeated_title_suffix("Growth Of Giggle - 나무위키", ["킬로그램 - 나무위키"]),
            "Growth Of Giggle - 나무위키",
        )

    def test_strips_rightmost_segment_only(self) -> None:
        previous = [
            "서비스 예약 | 고객지원 | LG전자",
            "베스트샵 | LG전자",
        ]
        self.assertEqual(
            strip_repeated_title_suffix("출장 서비스 예약 | 고객지원 | LG전자", previous),
            "출장 서비스 예약 | 고객지원",
        )

    def test_keeps_title_when_core_would_be_too_short(self) -> None:
        previous = ["a - 나무위키", "b - 나무위키"]
        self.assertEqual(strip_repeated_title_suffix("c - 나무위키", previous), "c - 나무위키")

    def test_title_without_separator_passes_through(self) -> None:
        self.assertEqual(strip_repeated_title_suffix("연합뉴스TV", ["연합뉴스TV"]), "연합뉴스TV")


class AnchorAdmissionGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(Path(self.tmpdir.name) / "kibitzer.sqlite3")
        self.session_id = self.store.create_session().id

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _record(self, obs_id: str, verdict: Verdict, emb: list[float], anchor_eligible: bool | None) -> None:
        self.store.record_observation(
            Observation(
                id=obs_id,
                ts=datetime.now(timezone.utc),
                session_id=self.session_id,
                source=Source.BROWSER_NAV,
                payload={"url_host": "example.com", "title": obs_id},
                features=ObservationFeatures(emb=emb, anchor_eligible=anchor_eligible),
                verdict=verdict,
            )
        )

    def test_anchor_excludes_ineligible_oks_and_keeps_legacy_rows(self) -> None:
        self._record("obs_goal_affine", Verdict.OK, [1.0, 0.0], anchor_eligible=True)
        self._record("obs_anchor_only", Verdict.OK, [0.0, 1.0], anchor_eligible=False)
        self._record("obs_legacy", Verdict.OK, [1.0, 0.0], anchor_eligible=None)
        self._record("obs_drift", Verdict.DRIFT, [0.0, 1.0], anchor_eligible=True)

        embeddings = self.store.recent_ok_embeddings(self.session_id, limit=10)

        self.assertEqual(len(embeddings), 2)  # eligible + legacy; anchor-only OK excluded
        self.assertNotIn([0.0, 1.0], embeddings)

    def test_recent_titles_for_host_returns_recent_titles(self) -> None:
        for index in range(3):
            self._record(f"page {index} - 나무위키", Verdict.OK, [1.0, 0.0], anchor_eligible=True)
        titles = self.store.recent_titles_for_host("example.com", limit=2)
        self.assertEqual(len(titles), 2)
        self.assertTrue(all(title.endswith("- 나무위키") for title in titles))
        self.assertEqual(self.store.recent_titles_for_host("other.com"), [])


class WikiRabbitHoleRegressionTest(unittest.TestCase):
    """Replays the 나무위키 chain from the incident through the real API."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        self.store = SQLiteStore(self.db_path)
        config = AppConfig(server=ServerConfig(db_path=str(self.db_path)))
        self.client = TestClient(create_app(config=config, store=self.store))
        self.client.__enter__()
        self.client.post("/sessions")
        self.client.post("/sessions/current/goal", json={"raw_text": "LG그램 수리"})

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _visit(self, host: str, path: str, title: str) -> str:
        response = self.client.post(
            "/observations/browser-nav",
            json={
                "source": "browser_nav",
                "payload": {"url": f"https://{host}{path}", "title": title, "tab_id": 1},
            },
        )
        self.assertEqual(response.status_code, 200)
        observation_id = response.json()["observation_id"]
        observation = self.store.get_observation(observation_id)
        assert observation is not None and observation.verdict is not None
        return observation.verdict

    def test_wiki_chain_no_longer_rides_the_anchor(self) -> None:
        # On-goal pages seed the anchor, as in the incident.
        self._visit("www.google.com", "/search1", "그램 수리 - Google 검색")
        self._visit("it.donga.com", "/review", "LG 그램 수리 후기")

        # The lexical trap ("그램" bigram) may legitimately pass Tier 0 — the fix
        # is that the platform must not get whitelisted behind it.
        self._visit("namu.wiki", "/w/kg", "킬로그램 - 나무위키")
        self._visit("namu.wiki", "/w/gog", "Growth Of Giggle - 나무위키")

        # From here the furniture is learned (>= 2 previous "- 나무위키" titles)
        # and anchor-only OKs have no vote: the chain must read as drift.
        self.assertEqual(
            self._visit("namu.wiki", "/w/minions", "미니언즈 & 몬스터즈 - 나무위키"), "DRIFT"
        )
        self.assertEqual(self.client.get("/health").json()["mode"], "active")
        self.assertEqual(
            self._visit("namu.wiki", "/w/queen", "현덕왕후 - 나무위키"), "DRIFT"
        )
        self.assertEqual(
            self._visit("namu.wiki", "/w/ronaldo", "크리스티아누 호날두 - 나무위키"), "DRIFT"
        )

    def test_on_goal_pages_still_ok_after_fixes(self) -> None:
        self.assertEqual(self._visit("www.google.com", "/s", "그램 수리 - Google 검색"), "OK")
        self.assertEqual(self._visit("it.donga.com", "/r", "LG 그램 수리 후기"), "OK")


class HealthTierStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"
        config = AppConfig(server=ServerConfig(db_path=str(db_path)))
        self.client = TestClient(create_app(config=config, store=SQLiteStore(db_path)))
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def test_health_reports_degraded_tiers_without_waking_runtime(self) -> None:
        body = self.client.get("/health").json()
        # No credentials resolve in the test environment: both tiers degraded,
        # and probing them must not activate the idle runtime.
        self.assertEqual(body["tiers"], {"tier1": "degraded", "tier2": "degraded"})
        self.assertEqual(body["mode"], "idle")
        self.assertEqual(self.client.get("/health").json()["mode"], "idle")


if __name__ == "__main__":
    unittest.main()

import asyncio
import csv
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from apps.server.tests.support import TestClient

from apps.server.app.config import (
    AppConfig,
    ControllerConfig,
    GoalEnrichmentConfig,
    JudgmentAuditConfig,
    ServerConfig,
    Tier1Config,
    Tier2Config,
)
from apps.server.app.core.audit_routing import choose_audit_trigger, host_family
from apps.server.app.main import create_app
from apps.server.app.providers.judges.base import Tier1Result
from apps.server.app.replay import replay_session
from apps.server.app.schemas import Verdict
from apps.server.app.storage.sqlite import SQLiteStore


class FakeTier1Provider:
    def __init__(self, result: Tier1Result) -> None:
        self.result = result
        self.payloads: list[dict[str, object]] = []

    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        self.payloads.append(payload)
        return self.result


class RaisingTier1Provider:
    async def classify_tier1(self, payload: dict[str, object]) -> Tier1Result:
        raise RuntimeError("tier1 unavailable")


class AuditTriggerUnitTest(unittest.TestCase):
    def test_low_margin_trigger_and_boundary(self) -> None:
        config = JudgmentAuditConfig(audit_ok_below=0.7)

        self.assertEqual(
            choose_audit_trigger(
                verdict=Verdict.OK,
                tier0_score=0.699,
                title_quality="content_specific",
                host_family="example.com",
                host_family_verdicts=set(),
                config=config,
            ).trigger,
            "low_margin",
        )
        self.assertIsNone(
            choose_audit_trigger(
                verdict=Verdict.OK,
                tier0_score=0.7,
                title_quality="content_specific",
                host_family="example.com",
                host_family_verdicts=set(),
                config=config,
            ).trigger
        )

    def test_low_quality_mixed_and_risk_triggers_are_configurable(self) -> None:
        base = dict(verdict=Verdict.OK, tier0_score=0.9, host_family="example.com")

        self.assertEqual(
            choose_audit_trigger(
                **base,
                title_quality="generic",
                host_family_verdicts=set(),
                config=JudgmentAuditConfig(audit_low_quality_titles=True),
            ).trigger,
            "low_quality_title",
        )
        self.assertIsNone(
            choose_audit_trigger(
                **base,
                title_quality="generic",
                host_family_verdicts=set(),
                config=JudgmentAuditConfig(audit_low_quality_titles=False),
            ).trigger
        )
        self.assertEqual(
            choose_audit_trigger(
                **base,
                title_quality="content_specific",
                host_family_verdicts={Verdict.DRIFT},
                config=JudgmentAuditConfig(audit_mixed_hosts=True),
            ).trigger,
            "mixed_host",
        )
        self.assertIsNone(
            choose_audit_trigger(
                **base,
                title_quality="content_specific",
                host_family_verdicts={Verdict.DRIFT},
                config=JudgmentAuditConfig(audit_mixed_hosts=False),
            ).trigger
        )
        self.assertEqual(
            choose_audit_trigger(
                **base,
                title_quality="content_specific",
                host_family_verdicts=set(),
                config=JudgmentAuditConfig(risk_hosts=["example.com"]),
            ).trigger,
            "risk_host",
        )

    def test_non_ok_or_disabled_audit_does_not_trigger(self) -> None:
        self.assertIsNone(
            choose_audit_trigger(
                verdict=Verdict.DRIFT,
                tier0_score=0.1,
                title_quality="generic",
                host_family="example.com",
                host_family_verdicts={Verdict.DRIFT},
                config=JudgmentAuditConfig(),
            ).trigger
        )
        self.assertIsNone(
            choose_audit_trigger(
                verdict=Verdict.OK,
                tier0_score=0.1,
                title_quality="generic",
                host_family="example.com",
                host_family_verdicts={Verdict.DRIFT},
                config=JudgmentAuditConfig(enabled=False),
            ).trigger
        )

    def test_host_family_normalization(self) -> None:
        self.assertEqual(host_family("www.google.com"), "google.com")
        self.assertEqual(host_family("search.google.com"), "google.com")
        self.assertEqual(host_family("m.sports.naver.com"), "naver.com")
        self.assertEqual(host_family("www.lge.co.kr"), "lge.co.kr")
        self.assertEqual(host_family("gall.dcinside.com"), "dcinside.com")


class AuditRoutingApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "kibitzer.sqlite3"

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def _audit_client(self, provider) -> tuple[TestClient, SQLiteStore]:
        store = SQLiteStore(self.db_path)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
            tier1=Tier1Config(enabled=True),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
        )
        client = TestClient(create_app(config=config, store=store, tier1_provider=provider))
        client.__enter__()
        return client, store

    def _visit(self, client: TestClient, url: str, title: str):
        return client.post(
            "/observations/browser-nav",
            json={"source": "browser_nav", "payload": {"url": url, "title": title}},
        )

    def test_audited_ok_can_stay_ok_but_generic_title_cannot_anchor(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.OK, reason="same goal"))
        client, store = self._audit_client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "YouTube"})
            response = self._visit(client, "https://www.youtube.com/", "YouTube")
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "OK")
        self.assertEqual(len(provider.payloads), 1)
        self.assertEqual(provider.payloads[0]["audit"]["trigger"], "low_quality_title")

        observation = store.list_observations(session_id)[0]
        self.assertEqual(observation.tier_reached, 1)
        self.assertEqual(observation.features["title_quality"], "generic")
        self.assertEqual(observation.features["audit_trigger"], "low_quality_title")
        self.assertFalse(observation.features["anchor_eligible"])
        self.assertEqual(store.recent_ok_embeddings(session_id, limit=10), [])

    def test_audited_ok_can_become_drift_before_controller(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.DRIFT, reason="bare platform"))
        client, store = self._audit_client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "YouTube"})
            response = self._visit(client, "https://www.youtube.com/", "YouTube")
        finally:
            client.__exit__(None, None, None)

        body = response.json()
        self.assertEqual(body["verdict"], "DRIFT")
        self.assertEqual(body["action"], "request_excerpt")
        observation = store.list_observations(session_id)[0]
        self.assertEqual(observation.verdict, "DRIFT")
        self.assertEqual(observation.tier_reached, 1)
        self.assertEqual(observation.tier1_reason, "bare platform")

    def test_audited_ok_provider_error_keeps_tier0_ok(self) -> None:
        client, store = self._audit_client(RaisingTier1Provider())
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "YouTube"})
            response = self._visit(client, "https://www.youtube.com/", "YouTube")
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(response.json()["verdict"], "OK")
        observation = store.list_observations(session_id)[0]
        self.assertEqual(observation.tier_reached, 0)
        self.assertEqual(observation.features["audit_trigger"], "low_quality_title")
        with closing(sqlite3.connect(self.db_path)) as conn:
            payload = json.loads(
                conn.execute(
                    "SELECT payload_json FROM event_log WHERE event_type = 'tier1.provider_error'"
                ).fetchone()[0]
            )
        self.assertEqual(payload["audit"]["trigger"], "low_quality_title")

    def test_audit_reuse_skips_second_tier1_call_for_same_page(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.DRIFT, reason="bare platform"))
        client, store = self._audit_client(provider)
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "YouTube"})
            first = self._visit(client, "https://www.youtube.com/", "YouTube")
            second = self._visit(client, "https://www.youtube.com/feed", "YouTube")
        finally:
            client.__exit__(None, None, None)

        self.assertEqual(first.json()["verdict"], "DRIFT")
        self.assertEqual(second.json()["verdict"], "DRIFT")
        self.assertEqual(len(provider.payloads), 1)

        observations = store.list_observations(session_id)
        self.assertEqual(len(observations), 2)
        revisit = observations[1]
        self.assertEqual(revisit.verdict, "DRIFT")
        self.assertEqual(revisit.tier_reached, 1)
        self.assertEqual(revisit.tier1_reason, "bare platform")
        self.assertTrue(revisit.features["audit_cached"])
        with closing(sqlite3.connect(self.db_path)) as conn:
            reused = json.loads(
                conn.execute(
                    "SELECT payload_json FROM event_log WHERE event_type = 'tier1.audit_reused'"
                ).fetchone()[0]
            )
        self.assertEqual(reused["observation_id"], revisit.id)
        self.assertEqual(reused["source_observation_id"], observations[0].id)

    def test_replay_mirrors_audit_routing_and_reuse(self) -> None:
        provider = FakeTier1Provider(Tier1Result(verdict=Verdict.DRIFT, reason="bare platform"))
        client, store = self._audit_client(provider)
        config = AppConfig(
            server=ServerConfig(db_path=str(self.db_path)),
            goal_enrichment=GoalEnrichmentConfig(enabled=False),
            tier1=Tier1Config(enabled=True),
            tier2=Tier2Config(enabled=False),
            controller=ControllerConfig(k=1, coldstart_observations=1, cooldown_seconds=0),
        )
        try:
            session_id = client.post("/sessions").json()["id"]
            client.post("/sessions/current/goal", json={"raw_text": "YouTube"})
            self._visit(client, "https://www.youtube.com/", "YouTube")
            self._visit(client, "https://www.youtube.com/feed", "YouTube")
        finally:
            client.__exit__(None, None, None)

        result = asyncio.run(replay_session(self.db_path, session=session_id, config=config))
        first, second = result.rows
        self.assertEqual(first.title_quality, "generic")
        self.assertEqual(first.audit_trigger, "low_quality_title")
        self.assertFalse(first.audit_cached)
        self.assertTrue(first.tier1_would_call)
        self.assertEqual(first.verdict_replay, "DRIFT")
        self.assertEqual(first.tier_replay, 1)

        self.assertEqual(second.audit_trigger, "low_quality_title")
        self.assertTrue(second.audit_cached)
        self.assertFalse(second.tier1_would_call)
        self.assertEqual(second.verdict_replay, "DRIFT")
        self.assertEqual(second.tier_replay, 1)
        self.assertEqual(result.summary["audit"], {"triggered": 2, "fresh": 1, "cached": 1})


class AuditRoutingCorpusRegressionTest(unittest.TestCase):
    def test_private_corpus_coverage_and_fresh_audit_volume(self) -> None:
        corpus_root = os.environ.get("KIBITZER_AUDIT_CORPUS")
        audit_db = os.environ.get("KIBITZER_AUDIT_DB")
        if not corpus_root or not audit_db:
            self.skipTest("set KIBITZER_AUDIT_CORPUS and KIBITZER_AUDIT_DB for the private regression")

        root = Path(corpus_root)
        phrases_path = root / "derived-phrases-eval.json"
        phrases_by_session = json.loads(phrases_path.read_text(encoding="utf-8"))["goals"]
        config = AppConfig()

        false_ok_keys: set[tuple[str, str, str]] = set()
        routed_false_ok_keys: set[tuple[str, str, str]] = set()
        related_ok_total = 0
        related_ok_fresh_audits = 0

        for csv_path in sorted(root.glob("labeled-sess_*.csv")):
            session_id = csv_path.stem.removeprefix("labeled-")
            self.assertIn(session_id, phrases_by_session)
            result = asyncio.run(
                replay_session(
                    audit_db,
                    session=session_id,
                    config=config,
                    derived_phrases_path=phrases_path,
                )
            )
            with csv_path.open(encoding="utf-8", newline="") as handle:
                labeled_rows = list(csv.DictReader(handle))
            self.assertEqual(len(result.rows), len(labeled_rows))

            for replayed, labeled in zip(result.rows, labeled_rows, strict=True):
                self.assertEqual(replayed.title, labeled["title"])
                tier0_ok = replayed.r0_replay is not None and replayed.r0_replay >= config.relevance.tau_ok
                key = (session_id, replayed.ts.isoformat(), replayed.title or "")
                if labeled["hand_label"] == "drift" and tier0_ok:
                    false_ok_keys.add(key)
                    if replayed.audit_trigger:
                        routed_false_ok_keys.add(key)
                if labeled["hand_label"] == "related" and tier0_ok:
                    related_ok_total += 1
                    if replayed.audit_trigger and not replayed.audit_cached:
                        related_ok_fresh_audits += 1

        # ONNX-era acceptance shape (handoff re-implementation note 2): every
        # surviving labeled false-OK must fire a trigger, and fresh audits must
        # stay within the cost bar. The hash-era absolute counts (7; 27/110) no
        # longer apply — print the measured values for recalibration notes.
        print(
            "audit-corpus:",
            {
                "false_ok": len(false_ok_keys),
                "routed": len(routed_false_ok_keys),
                "related_ok_total": related_ok_total,
                "fresh_audits": related_ok_fresh_audits,
            },
        )
        self.assertEqual(routed_false_ok_keys, false_ok_keys)
        if related_ok_total:
            self.assertLessEqual(related_ok_fresh_audits / related_ok_total, 0.30)


if __name__ == "__main__":
    unittest.main()

import asyncio
import csv
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path

from apps.server.app.config import AppConfig, GoalEnrichmentConfig
from apps.server.app.core.goal_enrichment import (
    build_goal_enrichment_prompt,
    enrich_goal_derived_exemplars,
    filter_derived_phrases,
    parse_goal_enrichment_response,
    request_goal_phrases,
)
from apps.server.app.core.normalization import strip_repeated_title_suffix
from apps.server.app.core.relevance import tier0_score_parts
from apps.server.app.providers.embeddings.hash_cpu import HashCpuEmbeddingProvider
from apps.server.app.storage.sqlite import SQLiteStore


@dataclass
class FakeGoalProvider:
    responses: list[str]
    prompts: list[str] = field(default_factory=list)
    timeouts: list[float] = field(default_factory=list)

    async def complete_goal_enrichment(self, prompt: str, timeout_seconds: float) -> str:
        self.prompts.append(prompt)
        self.timeouts.append(timeout_seconds)
        return self.responses.pop(0)


class FixedEmbeddingProvider:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = {
            "near phrase one": [1.0, 0.0, 0.0],
            "near phrase two": [0.999, 0.001, 0.0],
            "unique phrase": [0.0, 1.0, 0.0],
        }
        return [vectors.get(text, [0.0, 0.0, 1.0]) for text in texts]


class GoalEnrichmentTest(unittest.IsolatedAsyncioTestCase):
    def test_prompt_and_strict_parse(self) -> None:
        prompt = build_goal_enrichment_prompt("마인크래프트 크리에이트모드", 8)

        self.assertIn('Declared goal (verbatim): "마인크래프트 크리에이트모드"', prompt)
        self.assertIn("At most 8 phrases", prompt)
        self.assertIn('"국내 숙소 예약 비교"', prompt)
        self.assertEqual(
            parse_goal_enrichment_response('{"phrases":["Minecraft Create mod train","Create rails"]}', 1),
            ["Minecraft Create mod train"],
        )
        # Live cloud models wrap the JSON in thinking preambles / code fences;
        # the parser extracts the brace window like the tier judges do.
        self.assertEqual(
            parse_goal_enrichment_response(
                'Sure, here are the phrases:\n```json\n{"phrases":["Create mod train"]}\n```',
                8,
            ),
            ["Create mod train"],
        )
        with self.assertRaises(json.JSONDecodeError):
            parse_goal_enrichment_response("no json here at all", 8)

    async def test_request_retries_once_on_parse_failure(self) -> None:
        provider = FakeGoalProvider(['not json', '{"phrases":["Minecraft Create mod train"]}'])

        phrases = await request_goal_phrases(
            provider,
            "마인크래프트 크리에이트모드",
            GoalEnrichmentConfig(max_phrases=8, timeout_seconds=12),
        )

        self.assertEqual(phrases, ["Minecraft Create mod train"])
        self.assertEqual(len(provider.prompts), 2)
        self.assertEqual(provider.timeouts, [12, 12])

    async def test_filter_drops_caps_duplicates_and_near_duplicates(self) -> None:
        filtered = await filter_derived_phrases(
            [
                "raw goal phrase",
                "near phrase one",
                "near phrase two",
                "near phrase one",
                "single",
                "one two three four five six seven eight nine",
                "unique phrase",
            ],
            goal_text="raw goal phrase",
            embedding_provider=FixedEmbeddingProvider(),
            max_phrases=8,
        )

        self.assertEqual([item.phrase for item in filtered], ["near phrase one", "unique phrase"])

    async def test_enrichment_failure_records_event_and_keeps_goal(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            store.initialize()
            session = store.create_session()
            store.set_current_goal("Kibitzer observation API", exemplar=[1.0, 0.0])

            await enrich_goal_derived_exemplars(
                session_id=session.id,
                goal_text="Kibitzer observation API",
                provider=FakeGoalProvider(["not json", "still not json"]),
                embedding_provider=HashCpuEmbeddingProvider(dimensions=16),
                store=store,
                config=GoalEnrichmentConfig(enabled=True, max_phrases=8),
            )

            current = store.get_current_session()
            self.assertIsNotNone(current)
            self.assertEqual(current.goal.raw_text, "Kibitzer observation API")
            self.assertEqual(current.goal.derived_exemplars, [])

            with closing(sqlite3.connect(db_path)) as conn:
                event = conn.execute(
                    "SELECT event_type, payload_json FROM event_log WHERE event_type = 'goal.enrichment_failed'"
                ).fetchone()
            self.assertIsNotNone(event)

    async def test_success_writes_derived_exemplars_and_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kibitzer.sqlite3"
            store = SQLiteStore(db_path)
            store.initialize()
            session = store.create_session()
            store.set_current_goal("Kibitzer observation API", exemplar=[1.0, 0.0])

            await enrich_goal_derived_exemplars(
                session_id=session.id,
                goal_text="Kibitzer observation API",
                provider=FakeGoalProvider(['{"phrases":["Kibitzer API docs","browser observation API"]}']),
                embedding_provider=HashCpuEmbeddingProvider(dimensions=16),
                store=store,
                config=GoalEnrichmentConfig(enabled=True, max_phrases=8),
            )

            current = store.get_current_session()
            self.assertEqual(current.goal.derived_phrases, ["Kibitzer API docs", "browser observation API"])


class GoalEnrichmentCorpusRegressionTest(unittest.TestCase):
    def test_step0_fixed_phrases_keep_false_drift_under_acceptance_bar(self) -> None:
        corpus_path = os.environ.get("KIBITZER_AUDIT_CORPUS")
        if not corpus_path:
            self.skipTest("set KIBITZER_AUDIT_CORPUS to run the private browsing-corpus regression")
        root = Path(corpus_path)
        phrases_by_session = json.loads((root / "derived-phrases-eval.json").read_text(encoding="utf-8"))["goals"]
        config = AppConfig()
        provider = HashCpuEmbeddingProvider(
            dimensions=config.embedding.dimensions,
            normalize=config.embedding.normalize,
        )

        rows = []
        for csv_path in sorted(root.glob("labeled-sess_*.csv")):
            session_id = csv_path.stem.removeprefix("labeled-")
            phrases = phrases_by_session[session_id]["phrases"]
            phrase_vectors = asyncio.run(provider.embed(phrases))
            recent_titles_by_host: dict[str, list[str]] = {}
            with csv_path.open(encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    previous_titles = recent_titles_by_host.get(row["url_host"], [])
                    embedding_text = strip_repeated_title_suffix(row["title"].strip(), previous_titles)
                    title_vector = asyncio.run(provider.embed([embedding_text]))[0]
                    baseline_r0 = float(row["r0_replay"])
                    derived = tier0_score_parts(
                        emb=title_vector,
                        exemplars=[],
                        anchor=None,
                        beta=config.relevance.beta,
                        derived_exemplars=phrase_vectors,
                        derived_tau=config.goal_enrichment.derived_tau,
                    )
                    enriched_r0 = max(baseline_r0, derived.score)
                    rows.append(
                        {
                            "key": (session_id, row["ts"], row["title"]),
                            "hand_label": row["hand_label"],
                            "baseline_r0": baseline_r0,
                            "enriched_r0": enriched_r0,
                        }
                    )
                    if row["title"]:
                        recent_titles_by_host.setdefault(row["url_host"], []).insert(0, row["title"])
                        del recent_titles_by_host[row["url_host"]][10:]

        tau_ok = config.relevance.tau_ok
        baseline_false_ok = {row["key"] for row in rows if row["hand_label"] == "drift" and row["baseline_r0"] >= tau_ok}
        enriched_false_ok = {row["key"] for row in rows if row["hand_label"] == "drift" and row["enriched_r0"] >= tau_ok}
        false_drift = [row for row in rows if row["hand_label"] == "related" and row["enriched_r0"] < tau_ok]
        new_false_ok = [row for row in rows if row["key"] in (enriched_false_ok - baseline_false_ok)]

        self.assertEqual(len(baseline_false_ok), 9)
        self.assertLessEqual(len(false_drift), 30)
        self.assertTrue(new_false_ok)
        self.assertTrue(all(row["enriched_r0"] < 0.35 for row in new_false_ok))


if __name__ == "__main__":
    unittest.main()

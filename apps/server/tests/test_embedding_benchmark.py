from __future__ import annotations

import unittest
from collections import Counter

from apps.server.app.config import AppConfig
from scripts.benchmark_tier0_embeddings import (
    DEFAULT_DATASET,
    ScoredPair,
    build_tag_summary,
    build_sweep,
    load_and_validate_dataset,
    parse_method_spec,
    resolve_methods,
    score_method,
    select_operating_point,
    validate_embedding_batch,
)


def scored(item_id: str, label: str, score: float) -> ScoredPair:
    return ScoredPair(
        id=item_id,
        group_id="group",
        anchor="anchor",
        title=item_id,
        label=label,
        tags=["short_anchor"],
        source="generated",
        rationale="test",
        score=score,
    )


class OperatingPointTest(unittest.TestCase):
    def test_selects_highest_recall_within_fpr_budget(self) -> None:
        pairs = [
            scored("p1", "OK", 0.9),
            scored("n1", "DRIFT", 0.85),
            scored("p2", "OK", 0.8),
            scored("n2", "DRIFT", 0.7),
            scored("p3", "OK", 0.4),
            scored("p4", "OK", 0.3),
            scored("n3", "DRIFT", 0.2),
            scored("n4", "DRIFT", 0.1),
        ]
        sweep = build_sweep(pairs)

        strict = select_operating_point(sweep, 0.25)
        relaxed = select_operating_point(sweep, 0.50)

        self.assertEqual((strict.tp, strict.fp), (2, 1))
        self.assertAlmostEqual(strict.threshold, 0.8)
        self.assertEqual((relaxed.tp, relaxed.fp), (4, 2))
        self.assertAlmostEqual(relaxed.threshold, 0.3)

    def test_tie_break_prefers_lower_fpr_then_higher_threshold(self) -> None:
        pairs = [
            scored("p1", "OK", 0.9),
            scored("n1", "DRIFT", 0.8),
            scored("n2", "DRIFT", 0.7),
        ]

        point = select_operating_point(build_sweep(pairs), 1.0)

        self.assertEqual((point.tp, point.fp), (1, 0))
        self.assertAlmostEqual(point.threshold, 0.9)


class BenchmarkDatasetTest(unittest.TestCase):
    def test_full_dataset_satisfies_benchmark_contract(self) -> None:
        pairs = load_and_validate_dataset(DEFAULT_DATASET)

        self.assertEqual(len(pairs), 200)
        self.assertEqual(Counter(item["label"] for item in pairs), Counter({"DRIFT": 120, "OK": 80}))
        self.assertEqual(len({item["group_id"] for item in pairs}), 40)


class BenchmarkMethodContractTest(unittest.TestCase):
    def test_resolves_builtin_and_external_factories_without_runner_edits(self) -> None:
        methods = resolve_methods(
            [
                "hash",
                "candidate=scripts.benchmark_tier0_embeddings:create_hash_method",
            ],
            AppConfig(),
        )

        self.assertEqual([method.name for method in methods], ["hash", "candidate"])
        self.assertEqual(methods[0].source, "builtin:hash")
        self.assertEqual(
            methods[1].source,
            "scripts.benchmark_tier0_embeddings:create_hash_method",
        )
        self.assertTrue(all(callable(method.provider.embed) for method in methods))

    def test_method_names_and_duplicate_names_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid method name"):
            parse_method_spec("Bad Name=scripts.module:create")
        with self.assertRaisesRegex(ValueError, "MODULE:FACTORY"):
            parse_method_spec("candidate=missing_target")
        with self.assertRaisesRegex(ValueError, "duplicate method name"):
            resolve_methods(["hash", "hash"], AppConfig())

    def test_embedding_batch_contract_validates_shape_and_values(self) -> None:
        self.assertEqual(
            validate_embedding_batch("candidate", ["a", "b"], [[1.0, 0.0], [0.0, 1.0]]),
            2,
        )
        with self.assertRaisesRegex(ValueError, "2 vectors for 1 inputs"):
            validate_embedding_batch("candidate", ["a"], [[1.0], [1.0]])
        with self.assertRaisesRegex(ValueError, "dimension 1; expected 2"):
            validate_embedding_batch("candidate", ["a"], [[1.0]], expected_dimensions=2)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            validate_embedding_batch("candidate", ["a"], [[float("nan")]])
        with self.assertRaisesRegex(ValueError, "is zero"):
            validate_embedding_batch("candidate", ["a"], [[0.0, 0.0]])

    def test_tag_summary_uses_arbitrary_method_names(self) -> None:
        pairs = [
            {"id": "ok", "label": "OK", "tags": ["short_title"]},
            {"id": "drift", "label": "DRIFT", "tags": ["short_title"]},
        ]
        scores = {
            ("hash", "ok"): 0.1,
            ("hash", "drift"): 0.2,
            ("candidate", "ok"): 0.8,
            ("candidate", "drift"): 0.3,
        }

        summary = build_tag_summary(pairs, scores, ["hash", "candidate"])

        self.assertEqual(len(summary), 1)
        self.assertAlmostEqual(summary[0]["candidate_ok_mean"], 0.8)
        self.assertAlmostEqual(summary[0]["candidate_drift_mean"], 0.3)


class BenchmarkMethodStabilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_score_method_rejects_unstable_cold_and_warm_vectors(self) -> None:
        class UnstableProvider:
            calls = 0

            async def embed(self, texts: list[str]) -> list[list[float]]:
                self.calls += 1
                vector = [1.0, 0.0] if self.calls == 1 else [0.0, 1.0]
                return [vector[:] for _ in texts]

        pairs = [
            {
                "id": "pair",
                "group_id": "group",
                "anchor": "anchor",
                "title": "title",
                "label": "OK",
                "tags": ["short_anchor", "short_title"],
                "source": "generated",
                "rationale": "test",
            }
        ]

        with self.assertRaisesRegex(ValueError, "is not stable"):
            await score_method("unstable", "test:unstable", UnstableProvider(), pairs)


if __name__ == "__main__":
    unittest.main()

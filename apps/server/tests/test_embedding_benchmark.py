from __future__ import annotations

import unittest
from collections import Counter

from scripts.benchmark_tier0_embeddings import (
    DEFAULT_DATASET,
    ScoredPair,
    build_sweep,
    load_and_validate_dataset,
    select_operating_point,
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


if __name__ == "__main__":
    unittest.main()
